from flashadmin import model


def test_package_files_paths():
    pkg = {"agents": [{"file": "a.md", "content": "A"}], "skills": [{"file": "s.md", "content": "S"}],
           "scripts": [{"file": "x.ps1", "content": "X"}], "instructions": "I",
           "mcpServers": [{"id": "m"}], "exam": {"port": 1}}
    paths = [p for p, _ in model.package_files(pkg)]
    assert paths == ["agents/a.md", "skills/s.md", "scripts/x.ps1", "instructions.md", "mcpServers.json", "exam.json"]
    assert model.package_files(None) == []


def test_unified_and_stats():
    lines = model.unified("a\nb\n", "a\nc\nd\n", "f.md")
    assert lines[0] == "--- a/f.md" and "-b" in lines and "+c" in lines
    assert model.diff_stats([{"before": "a\nb", "after": "a\nc\nd"}]) == (2, 1)


def test_sort_pending_first_newest_first():
    subs = [{"id": 1, "status": "approved", "createdAt": "2026-11-18"},
            {"id": 2, "status": "pending", "createdAt": "2026-11-01"},
            {"id": 3, "status": "pending", "createdAt": "2026-11-10"}]
    assert [s["id"] for s in model.sort_submissions(subs)] == [3, 2, 1]


def test_user_note():
    note = model.user_note("https://x", "fs_t", "ana")
    assert "https://x" in note and "fs_t" in note and note.startswith("Hi ana")
