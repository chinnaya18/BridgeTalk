"""FastAPI application entry point.

Run with:
    uvicorn app.main:app --app-dir backend --reload

or via ./scripts/run_backend.sh
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app import __version__
from app.api import auth, meetings, transcripts
from app.config import settings
from app.database import engine, init_db
from app.ml.predictor import dynamic_predictor, isl_predictor, predictor
from app.ws import inference, signaling, transcribe
from app.ws.connection_manager import inference_manager, signaling_manager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s %(name)s  %(message)s",
)
logger = logging.getLogger("bridgetalk")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown work.

    Everything expensive or fallible happens here, once, rather than on the
    first request. In later phases this is also where the Keras model is loaded
    into memory — loading it per request would add seconds of latency to a
    system whose whole point is sub-second response.
    """
    logger.info("BridgeTalk backend v%s starting", __version__)

    # Fail fast and legibly if the database is unreachable. Without this check
    # the server starts happily and every request dies with a stack trace,
    # which is a much harder thing to debug ten minutes before a review.
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        logger.info("Database connection OK")
    except Exception as exc:  # noqa: BLE001 - we genuinely want any failure here
        logger.error("Database connection FAILED: %s", exc)
        logger.error(
            "Check DATABASE_URL in .env, and that MySQL is running. "
            "For a database-free demo, set DATABASE_URL=sqlite:///./bridgetalk.db"
        )
        raise

    init_db()
    logger.info("Tables verified")

    # Load the sign model once, here, rather than on the first prediction.
    # Loading it per request would add hundreds of milliseconds to a system
    # whose whole point is sub-second response.
    #
    # A missing model is NOT fatal: auth, meetings and transcripts must still
    # work while someone is training one. The inference socket reports
    # MODEL_NOT_LOADED to any client that connects.
    if predictor.load():
        logger.info("Sign recognition ready")
    else:
        logger.warning("Sign recognition unavailable — %s", predictor.load_error)

    # ISL is the alphabet BridgeTalk is being demonstrated with, but a
    # deployment may legitimately ship only one of the two alphabets, so a
    # missing model here is informational rather than a warning.
    if isl_predictor.load():
        logger.info(
            "ISL recognition ready — %d classes", len(isl_predictor.class_names)
        )
    else:
        logger.info("ISL recognition not available — %s", isl_predictor.load_error)

    # Model B is a stretch goal, so its absence is logged at INFO rather than
    # WARNING. A deployment with only Model A is the expected configuration,
    # not a degraded one, and logging it as a warning would train the reader to
    # ignore warnings.
    if dynamic_predictor.load():
        logger.info(
            "Word-sign recognition ready — %d glosses", len(dynamic_predictor.class_names)
        )
    else:
        logger.info("Word-sign recognition not available — %s", dynamic_predictor.load_error)

    # Whisper is the FALLBACK speech provider, so its absence is normal: most
    # demos use the browser's Web Speech API and never touch it. Logged at INFO
    # and never fatal — the transcribe socket reports MODEL_NOT_LOADED to any
    # client that asks for it.
    if transcribe.transcriber.load():
        logger.info("Whisper speech-to-text ready (%s)", transcribe.transcriber.model_size)
    else:
        logger.info("Whisper not available — %s", transcribe.transcriber.load_error)

    yield

    logger.info("BridgeTalk backend shutting down")
    engine.dispose()


app = FastAPI(
    title="BridgeTalk API",
    version=__version__,
    description=(
        "Real-time sign language to text translation for deaf and hearing "
        "participants.\n\n"
        "**Privacy note:** the sign-recognition WebSocket receives hand *landmark "
        "coordinates* only. Video frames never leave the browser."
    ),
    lifespan=lifespan,
)

# CORS: the browser refuses cross-origin requests unless the server explicitly
# opts in. The frontend runs on :5173 and the API on :8000, so those are
# different origins even though both are localhost.
#
# allow_credentials=True together with an explicit origin list (never "*") is
# required for the browser to send our Authorization header on these requests.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    # Development only, and off unless CORS_ALLOW_LAN=true. Accepts any
    # private-network address on the Vite dev port, so a second device keeps
    # working when DHCP changes this machine's address mid-session. See
    # config.py for why that is tolerable in development and not in production.
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if settings.cors_allow_lan:
    logger.warning(
        "CORS_ALLOW_LAN is on: any private-network origin on :5173 is accepted. "
        "This is for two-device development. Turn it off for anything deployed."
    )

app.include_router(auth.router)
app.include_router(meetings.router)
app.include_router(transcripts.router)
app.include_router(inference.router)
app.include_router(signaling.router)
app.include_router(transcribe.router)


@app.get("/health", tags=["system"], summary="Liveness and database probe")
def health() -> dict:
    """Report whether the API and its database are up.

    Used by the frontend's status panel and by the demo pre-flight check. It
    reports database status as a field rather than returning 503, so a
    half-working system is still diagnosable from one request.
    """
    database_ok = True
    database_error = None
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        database_ok = False
        database_error = str(exc)

    return {
        "status": "ok" if database_ok else "degraded",
        "version": __version__,
        "database": "connected" if database_ok else "unreachable",
        "database_error": database_error,
        # Handy during the review: proves which backend the frontend reached.
        "dialect": engine.dialect.name,
        # Model status here means the frontend can explain *why* sign detection
        # is unavailable instead of just failing to produce predictions.
        "model": predictor.describe(),
        "isl_model": isl_predictor.describe(),
        "dynamic_model": dynamic_predictor.describe(),
        "speech_to_text": {
            "whisper_loaded": transcribe.transcriber.is_loaded,
            "whisper_model": transcribe.transcriber.model_size,
            "whisper_error": transcribe.transcriber.load_error,
        },
        "websockets": {
            "inference": inference_manager.stats(),
            "signaling": signaling_manager.stats(),
        },
    }
