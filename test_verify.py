#!/usr/bin/env python3
"""Offline end-to-end verification for Agent Roundtable.

Starts the application in deterministic mock mode on an isolated port and
temporary data directory, then exercises authentication, meeting isolation,
shared snapshot hashing and the A -> B -> A discussion chain.

Run from the repository root:

    python test_verify.py
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parent
APPLICATION_DIRECTORY = REPOSITORY_ROOT / "app"
TEST_PORT = 8836
TEST_TOKEN = "test-verify-token"
BASE_URL = f"http://127.0.0.1:{TEST_PORT}"
SHARED_FILE_PATH = APPLICATION_DIRECTORY / "README.md"


def request_json(request_path, request_method="GET", request_body=None, use_token=True):
    """Send one JSON request and return (status_code, parsed_body)."""
    request_headers = {}
    encoded_body = None
    if request_body is not None:
        encoded_body = json.dumps(request_body, ensure_ascii=False).encode("utf-8")
        request_headers["Content-Type"] = "application/json; charset=utf-8"
    if use_token:
        request_headers["Authorization"] = "Bearer " + TEST_TOKEN
    request = urllib.request.Request(
        BASE_URL + request_path,
        data=encoded_body,
        headers=request_headers,
        method=request_method,
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            response_text = response.read().decode("utf-8")
            return response.status, json.loads(response_text) if response_text else None
    except urllib.error.HTTPError as http_error:
        response_text = http_error.read().decode("utf-8")
        try:
            parsed_error = json.loads(response_text)
        except json.JSONDecodeError:
            parsed_error = {"raw": response_text}
        return http_error.code, parsed_error


def wait_for_health(server_process, timeout_seconds=30):
    """Wait until /api/health answers or fail with captured server output."""
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if server_process.poll() is not None:
            output = server_process.stdout.read() if server_process.stdout else ""
            raise RuntimeError("server exited early:\n" + output)
        try:
            status_code, health_body = request_json("/api/health", use_token=False)
            if status_code == 200 and health_body and health_body.get("ok"):
                return health_body
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(0.25)
    raise RuntimeError("server did not become healthy in time")


def wait_for_message_count(expected_last_sequence, timeout_seconds=30):
    """Poll room state until the expected number of messages exists."""
    deadline = time.time() + timeout_seconds
    latest_state = None
    while time.time() < deadline:
        status_code, latest_state = request_json("/api/state?since=0")
        if status_code == 200 and latest_state.get("lastSeq", 0) >= expected_last_sequence:
            return latest_state
        time.sleep(0.2)
    raise AssertionError("timed out waiting for messages; last state: " + json.dumps(latest_state, ensure_ascii=False)[:800])


def sha256_of_file(file_path):
    """Return the lowercase SHA-256 of a file."""
    digest = hashlib.sha256()
    with open(file_path, "rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    if not SHARED_FILE_PATH.exists():
        raise RuntimeError("missing shared file for snapshot test: " + str(SHARED_FILE_PATH))

    node_executable = shutil.which("node")
    if not node_executable:
        raise RuntimeError("node executable not found on PATH")

    temporary_directory = Path(tempfile.mkdtemp(prefix="agent-roundtable-verify-"))
    server_environment = os.environ.copy()
    server_environment.update(
        {
            "R2_PORT": str(TEST_PORT),
            "R2_DATA_DIR": str(temporary_directory),
            "R2_HUMAN_TOKEN": TEST_TOKEN,
            "R2_PROVIDER_MOCK": "1",
        }
    )

    server_process = subprocess.Popen(
        [node_executable, "server.js"],
        cwd=str(APPLICATION_DIRECTORY),
        env=server_environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    try:
        health_body = wait_for_health(server_process)
        assert health_body["schema_version"] >= 3, "expected schema v3"
        print("PASS health and schema v3")

        token_file_path = temporary_directory / "room-token.txt"
        assert token_file_path.exists(), "room-token.txt was not generated"
        assert token_file_path.read_text(encoding="utf-8").strip() == TEST_TOKEN, "token file mismatch"
        print("PASS token generation")

        unauthorized_status, _ = request_json("/api/state", use_token=False)
        assert unauthorized_status == 401, f"expected 401 without token, got {unauthorized_status}"
        print("PASS authentication required")

        end_status, _ = request_json("/api/control", "POST", {"action": "end"})
        assert end_status == 200, f"failed to end initial meeting: {end_status}"

        create_status, meeting_one_body = request_json("/api/rooms", "POST", {"name": "verify-meeting-1"})
        assert create_status == 200, f"failed to create meeting one: {create_status} {meeting_one_body}"
        meeting_one_id = meeting_one_body["room"]["id"]
        print("PASS meeting one created")

        # Real provider names in mock mode: exercises the R2_PROVIDER_MOCK
        # switch inside makeProvider rather than the explicit "mock" provider.
        participant_providers = {
            "agent-a": "codex-cli/openai",
            "agent-b": "claude-code-cli/magpie",
        }
        for participant_id, participant_provider in participant_providers.items():
            invite_status, invite_body = request_json(
                "/api/invite",
                "POST",
                {
                    "provider": participant_provider,
                    "id": participant_id,
                    "label": participant_id.upper(),
                    "role": "评审者",
                },
            )
            assert invite_status == 200, f"failed to invite {participant_id}: {invite_status} {invite_body}"
        print("PASS mock mode over real provider names")

        expected_hash = sha256_of_file(SHARED_FILE_PATH)
        select_status, select_body = request_json(
            "/api/shared/select",
            "POST",
            {"path": str(SHARED_FILE_PATH)},
        )
        assert select_status == 200, f"shared selection failed: {select_status} {select_body}"
        selected_hash = select_body["shared"]["sha256"]
        assert selected_hash == expected_hash, "snapshot hash does not match local file"
        print("PASS shared snapshot hash")

        message_status, _ = request_json(
            "/api/messages",
            "POST",
            {
                "content": "请两位确认共享文件版本并推进方案。",
                "mode": "all",
                "client_id": "verify-chain-1",
            },
        )
        assert message_status == 200, f"failed to post discussion: {message_status}"

        final_state = wait_for_message_count(4)
        agent_messages = [message for message in final_state["messages"] if message["sender"] in ("agent-a", "agent-b")]
        assert len(agent_messages) == 3, f"expected 3 agent replies, got {len(agent_messages)}"
        assert [message["sender"] for message in agent_messages] == ["agent-a", "agent-b", "agent-a"], "unexpected A-B-A order"
        for message in agent_messages:
            assert expected_hash in message["content"], "reply did not echo the snapshot hash"
            assert message["status"] == "complete", "agent reply was not complete"
        print("PASS A-B-A discussion with snapshot hash")

        end_status, _ = request_json("/api/control", "POST", {"action": "end"})
        assert end_status == 200, "failed to end meeting one"

        create_status, meeting_two_body = request_json("/api/rooms", "POST", {"name": "verify-meeting-2"})
        assert create_status == 200, f"failed to create meeting two: {create_status} {meeting_two_body}"
        meeting_two_id = meeting_two_body["room"]["id"]
        assert meeting_two_id != meeting_one_id, "meeting two reused meeting one id"

        status_code, meeting_two_state = request_json("/api/state?since=0")
        assert status_code == 200, "failed to read meeting two state"
        assert meeting_two_state["messages"] == [], "meeting two inherited messages"
        assert meeting_two_state["room"]["id"] == meeting_two_id, "active room is not meeting two"

        status_code, rooms_body = request_json("/api/rooms")
        assert status_code == 200, "failed to list rooms"
        meeting_one_record = next(record for record in rooms_body["rooms"] if record["id"] == meeting_one_id)
        assert meeting_one_record["message_count"] >= 4, "meeting one history was not preserved"
        print("PASS meeting isolation and history")

        # Meeting two starts with its own draft snapshot; select the same file
        # again so the explicit mock provider can echo the expected hash.
        select_status, select_body = request_json(
            "/api/shared/select",
            "POST",
            {"path": str(SHARED_FILE_PATH)},
        )
        assert select_status == 200, f"meeting two snapshot selection failed: {select_status} {select_body}"

        # Explicit provider="mock" must also work without the environment flag
        # path being the only reason (factory branch coverage).
        invite_status, invite_body = request_json(
            "/api/invite",
            "POST",
            {"provider": "mock", "id": "agent-c", "label": "AGENT-C", "role": "评审者"},
        )
        assert invite_status == 200, f"failed to invite explicit mock provider: {invite_status} {invite_body}"
        message_status, _ = request_json(
            "/api/messages",
            "POST",
            {"content": "确认快照。", "mode": "single", "target": "agent-c", "client_id": "verify-mock-provider"},
        )
        assert message_status == 200, f"failed to post explicit mock message: {message_status}"
        mock_state = wait_for_message_count(2)
        mock_replies = [message for message in mock_state["messages"] if message["sender"] == "agent-c"]
        assert len(mock_replies) == 1 and expected_hash in mock_replies[0]["content"], "explicit mock provider did not reply"
        print("PASS explicit mock provider")

        print("TEST VERIFY PASS")
        return 0
    finally:
        if server_process.poll() is None:
            server_process.terminate()
            try:
                server_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server_process.kill()
                server_process.wait(timeout=5)
        shutil.rmtree(temporary_directory, ignore_errors=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as verification_error:
        print("TEST VERIFY FAIL: " + str(verification_error), file=sys.stderr)
        sys.exit(1)
