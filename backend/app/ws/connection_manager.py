"""Tracks live WebSocket connections, grouped by meeting.

Two things need this: the inference socket, which broadcasts recognised text to
the *other* participant so it can appear as their subtitle, and the WebRTC
signalling socket, which relays offers and ICE candidates between peers.

State lives in process memory, which is a real constraint worth naming: running
two backend workers would put two participants in two separate registries and
they would never see each other. For a 1:1 meeting on a single Uvicorn process
that is fine, and it is what this project runs. Scaling past that means moving
this registry into Redis — noted in the README's limitations rather than
pretended away.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Optional

from fastapi import WebSocket

logger = logging.getLogger("bridgetalk.ws")


@dataclass
class Connection:
    """One live socket, plus who is behind it."""

    websocket: WebSocket
    user_id: int
    user_name: str
    meeting_code: str
    # Arbitrary per-connection state — the inference endpoint parks its
    # PredictionSmoother here so smoothing is never shared between users.
    state: dict[str, Any] = field(default_factory=dict)


class ConnectionManager:
    """A registry of connections keyed by meeting code."""

    def __init__(self, channel: str) -> None:
        self.channel = channel
        self._rooms: dict[str, list[Connection]] = {}
        # Mutating a room while an async broadcast iterates it is a real race
        # in a busy meeting; the lock keeps membership changes atomic.
        self._lock = asyncio.Lock()

    async def connect(
        self, websocket: WebSocket, meeting_code: str, user_id: int, user_name: str
    ) -> Connection:
        """Accept the socket and register it against a meeting."""
        await websocket.accept()

        connection = Connection(
            websocket=websocket,
            user_id=user_id,
            user_name=user_name,
            meeting_code=meeting_code,
        )

        async with self._lock:
            self._rooms.setdefault(meeting_code, []).append(connection)
            occupancy = len(self._rooms[meeting_code])

        logger.info(
            "[%s] %s (id=%s) joined %s — %d connected",
            self.channel, user_name, user_id, meeting_code, occupancy,
        )
        return connection

    async def disconnect(self, connection: Connection) -> None:
        """Remove a socket from its meeting, dropping the room when empty."""
        async with self._lock:
            room = self._rooms.get(connection.meeting_code)
            if room and connection in room:
                room.remove(connection)
            # Delete empty rooms so a long-running server does not accumulate
            # a dictionary entry for every meeting ever held.
            if room is not None and not room:
                del self._rooms[connection.meeting_code]

        logger.info(
            "[%s] %s left %s", self.channel, connection.user_name, connection.meeting_code
        )

    async def send_personal(self, connection: Connection, message: dict) -> bool:
        """Send to one socket. Returns False if it has gone away."""
        try:
            await connection.websocket.send_json(message)
            return True
        except Exception:  # noqa: BLE001 - a dead socket is not an error worth raising
            # Common and expected: the browser tab closed between our last read
            # and this write. The caller cleans up.
            return False

    async def broadcast(
        self, meeting_code: str, message: dict, exclude: Optional[Connection] = None
    ) -> int:
        """Send to everyone in a meeting, optionally skipping the sender.

        Returns the number of sockets that accepted the message. Sends are
        sequential rather than gathered: a 1:1 meeting has one recipient, and
        sequential sends keep message ordering obvious.
        """
        async with self._lock:
            # Copy the list so the room can change while we are sending.
            recipients = list(self._rooms.get(meeting_code, []))

        delivered = 0
        dead: list[Connection] = []

        for connection in recipients:
            if connection is exclude:
                continue
            if await self.send_personal(connection, message):
                delivered += 1
            else:
                dead.append(connection)

        for connection in dead:
            await self.disconnect(connection)

        return delivered

    async def send_to_user(self, meeting_code: str, user_id: int, message: dict) -> int:
        """Send to one specific user's sockets in a meeting.

        WHY THIS IS NOT A BROADCAST
        ---------------------------
        Interview Mode violations are reported to the HOST in real time. A
        violation is a record *about* a participant, so broadcasting it to the
        room would show one candidate another candidate's lapses — which is
        surveillance of each other rather than a tool for the person running
        the interview, and it is exactly why `GET /focus-events` is host-only.

        A user may legitimately have more than one socket on a channel (a
        second tab), so every matching connection is sent to.

        Returns the number of sockets that accepted it.
        """
        async with self._lock:
            recipients = [
                connection
                for connection in self._rooms.get(meeting_code, [])
                if connection.user_id == user_id
            ]

        delivered = 0
        dead: list[Connection] = []
        for connection in recipients:
            try:
                await connection.websocket.send_json(message)
                delivered += 1
            except Exception:  # noqa: BLE001
                dead.append(connection)

        for connection in dead:
            await self.disconnect(connection)

        return delivered

    async def peers(self, meeting_code: str, exclude: Optional[Connection] = None) -> list[Connection]:
        """Everyone else currently in this meeting."""
        async with self._lock:
            return [c for c in self._rooms.get(meeting_code, []) if c is not exclude]

    def occupancy(self, meeting_code: str) -> int:
        return len(self._rooms.get(meeting_code, []))

    def stats(self) -> dict[str, int]:
        """Live counts, surfaced through /health."""
        return {
            "rooms": len(self._rooms),
            "connections": sum(len(room) for room in self._rooms.values()),
        }


# One registry per channel. They are separate on purpose: the inference socket
# and the signalling socket have different lifetimes and different failure
# modes, so a dropped video call must not also kill sign recognition.
inference_manager = ConnectionManager("inference")
signaling_manager = ConnectionManager("signaling")
