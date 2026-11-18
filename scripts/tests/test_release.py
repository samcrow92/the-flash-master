"""Tests for scripts/release.py: version suggestion, remote parsing, asset selection, CLI dry-run plumbing."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import release  # noqa: E402
from release import ReleaseError, Version, collect_assets, parse_remote_url, pick_base_version  # noqa: E402


@pytest.mark.parametrize(
    "base,kind,expected",
    [
        ("0.3.0", "patch", "0.3.1"),
        ("0.3.0", "minor", "0.4.0"),
        ("0.3.0", "major", "1.0.0"),
        ("0.3.7", "minor", "0.4.0"),
        # npm semantics: a pre-release bumps to its own release first
        ("0.3.0-build.3", "patch", "0.3.0"),
        ("0.3.0-build.3", "minor", "0.3.0"),
        ("0.3.1-rc.1", "minor", "0.4.0"),
        ("1.0.0-beta.2", "major", "1.0.0"),
        ("1.2.0-beta.2", "major", "2.0.0"),
    ],
)
def test_bump(base, kind, expected):
    assert str(Version.parse(base).bump(kind)) == expected


def test_version_ordering_follows_semver():
    order = ["0.9.9", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0", "1.0.1"]
    parsed = [Version.parse(v) for v in order]
    assert sorted(reversed(parsed)) == parsed
    assert Version.parse("v1.2.3").tag == "v1.2.3"


@pytest.mark.parametrize("bad", ["", "1.2", "v1", "1.2.3.4", "latest", "1.2.x"])
def test_parse_rejects_non_semver(bad):
    with pytest.raises(ValueError):
        Version.parse(bad)


def test_base_version_is_newest_github_release_including_drafts():
    releases = [
        {"tag_name": "v0.1.0-build.1", "draft": True, "prerelease": True},
        {"tag_name": "v0.3.0-build.3", "draft": True, "prerelease": True},
        {"tag_name": "nightly"},  # ignored: not a version
    ]
    base = pick_base_version(releases, "0.3.0")
    assert str(base.version) == "0.3.0-build.3"
    assert "draft pre-release" in base.source
    # this repo's state today: the suggestion is to release 0.3.0 itself
    assert [str(v) for _, v in release.suggestions(base.version, "0.3.0")] == ["0.3.0", "1.0.0"]


def test_package_json_is_the_fallback_and_an_extra_option_when_ahead():
    only_pkg = pick_base_version([], "0.3.0")
    assert str(only_pkg.version) == "0.3.0" and "no GitHub release" in only_pkg.source
    assert str(pick_base_version([], None).version) == "0.0.0"
    base = pick_base_version([{"tag_name": "v0.2.0"}], "0.5.0").version
    assert str(base) == "0.2.0"
    opts = release.suggestions(base, "0.5.0")
    assert [(k, str(v)) for k, v in opts] == [("patch", "0.2.1"), ("minor", "0.3.0"), ("major", "1.0.0"), ("from package.json", "0.5.0")]
    assert len(release.suggestions(base, "0.3.0")) == 3  # already offered as the minor bump


@pytest.mark.parametrize(
    "url,host,owner,repo,api",
    [
        ("https://github.com/samcrow92/the-flash-master", "github.com", "samcrow92", "the-flash-master", "https://api.github.com"),
        ("https://github.com/samcrow92/the-flash-master.git", "github.com", "samcrow92", "the-flash-master", "https://api.github.com"),
        ("git@github.com:samcrow92/the-flash-master.git", "github.com", "samcrow92", "the-flash-master", "https://api.github.com"),
        ("ssh://git@ssh.github.com:443/o/r.git", "github.com", "o", "r", "https://api.github.com"),
        ("https://user:tok@forvia-hella.ghe.com/team/the-flash-master", "forvia-hella.ghe.com", "team", "the-flash-master",
         "https://api.forvia-hella.ghe.com"),
        ("https://github.company.com/team/app.git", "github.company.com", "team", "app", "https://github.company.com/api/v3"),
    ],
)
def test_parse_remote_url(url, host, owner, repo, api):
    r = parse_remote_url(url)
    assert (r.host, r.owner, r.repo, r.api_base) == (host, owner, repo, api)


@pytest.mark.parametrize("bad", ["/local/path/repo", "https://github.com/onlyowner", "file:///x/y"])
def test_parse_remote_url_rejects(bad):
    with pytest.raises(ValueError):
        parse_remote_url(bad)


def _release_dir(tmp_path, version="0.3.1", manifest_version=None):
    d = tmp_path / "release"
    d.mkdir()
    for name in (f"TheFlashMaster-{version}-x64-setup.exe", f"TheFlashMaster-{version}-x64-portable.exe",
                 f"TheFlashMaster-{version}-x64-setup.exe.blockmap", "TheFlashMaster-0.3.0-x64-setup.exe", "SHA256SUMS.txt",
                 "builder-debug.yml"):
        (d / name).write_bytes(b"x")
    (d / "latest.json").write_text(json.dumps({"version": manifest_version or version}))
    (d / "win-unpacked").mkdir()
    return d


def test_collect_assets_picks_this_versions_files_only(tmp_path):
    d = _release_dir(tmp_path)
    names = [p.name for p in collect_assets(d, Version.parse("0.3.1"))]
    assert names == sorted([
        "SHA256SUMS.txt", "TheFlashMaster-0.3.1-x64-portable.exe", "TheFlashMaster-0.3.1-x64-setup.exe",
        "TheFlashMaster-0.3.1-x64-setup.exe.blockmap", "latest.json"])


def test_collect_assets_includes_latest_yml_for_this_version(tmp_path):
    d = _release_dir(tmp_path)
    (d / "latest.yml").write_text("version: 0.3.1\nfiles: []\n")
    assert "latest.yml" in [p.name for p in collect_assets(d, Version.parse("0.3.1"))]
    (d / "latest.yml").write_text("version: 0.3.0\n")
    assert "latest.yml" not in [p.name for p in collect_assets(d, Version.parse("0.3.1"))]


def test_collect_assets_reports_missing_and_stale_files(tmp_path):
    d = _release_dir(tmp_path)
    (d / "TheFlashMaster-0.3.1-x64-portable.exe").unlink()
    with pytest.raises(ReleaseError, match="portable"):
        collect_assets(d, Version.parse("0.3.1"))
    (tmp_path / "b").mkdir()
    stale = _release_dir(tmp_path / "b", manifest_version="0.3.0")
    with pytest.raises(ReleaseError, match="latest.json is for 0.3.0"):
        collect_assets(stale, Version.parse("0.3.1"))


def test_expected_assets_match_what_release_workflow_uploads():
    workflow = (Path(release.ROOT) / ".github" / "workflows" / "release.yml").read_text("utf-8")
    assert "release/*.exe release/latest.json release/SHA256SUMS.txt" in workflow
    assert release.expected_asset_names(Version.parse("1.0.0"))[2:] == ["latest.json", "SHA256SUMS.txt"]


def test_sha256_and_progress(tmp_path):
    f = tmp_path / "a.bin"
    f.write_bytes(b"abc" * 1000)
    seen = []
    import hashlib
    assert release.sha256_file(f, seen.append) == hashlib.sha256(b"abc" * 1000).hexdigest()
    assert sum(seen) == 3000


def test_resolve_token_prefers_env(monkeypatch):
    monkeypatch.setenv("GH_TOKEN", "abc")
    assert release.resolve_token("github.com") == ("abc", "$GH_TOKEN")
    monkeypatch.setenv("GH_ENTERPRISE_TOKEN", "ent")
    assert release.resolve_token("github.company.com") == ("ent", "$GH_ENTERPRISE_TOKEN")


def test_cli_flags_parse():
    a = release.build_parser().parse_args(["--dry-run", "--bump", "minor", "-y"])
    assert a.dry_run and a.bump == "minor" and a.yes
    with pytest.raises(SystemExit):
        release.build_parser().parse_args(["--bump", "minor", "--version", "1.0.0"])


def test_main_reports_errors_with_hints(monkeypatch, capsys):
    def boom(self):
        raise ReleaseError("something broke", "do this to fix it")

    monkeypatch.setattr(release.Release, "run", boom)
    assert release.main(["--no-color"]) == 1
    out = capsys.readouterr().out
    assert "something broke" in out and "do this to fix it" in out


def _release_for_resume(monkeypatch, tmp_path, info):
    monkeypatch.setattr(release, "BUILD_INFO", tmp_path / "build-info.json")
    if info is not None:
        (tmp_path / "build-info.json").write_text(json.dumps(info))
    r = release.Release(release.build_parser().parse_args(["--skip-build"]), release.UI(False))
    r.plan.source_ref, r.plan.source_sha = "origin/main", "b" * 40
    return r


def test_resume_tags_the_commit_the_files_were_built_from(monkeypatch, tmp_path):
    r = _release_for_resume(monkeypatch, tmp_path, {"version": "0.3.1", "sha": "a" * 40})
    r.use_built_commit(Version.parse("0.3.1"))
    assert r.plan.source_sha == "a" * 40  # main moved on after the build; the tag still matches the binaries


def test_resume_refuses_a_build_of_another_version_or_none(monkeypatch, tmp_path):
    r = _release_for_resume(monkeypatch, tmp_path, {"version": "0.3.0", "sha": "a" * 40})
    with pytest.raises(ReleaseError, match="holds a build of 0.3.0"):
        r.use_built_commit(Version.parse("0.3.1"))
    (tmp_path / "x").mkdir()
    r = _release_for_resume(monkeypatch, tmp_path / "x", None)
    with pytest.raises(ReleaseError, match="build-info.json is missing"):
        r.use_built_commit(Version.parse("0.3.1"))


def test_builds_from_the_remote_not_the_local_checkout():
    src = Path(release.__file__).read_text("utf-8")
    # no local-state gates: the release is a fresh worktree of <remote>/<ref>
    assert "git status --porcelain" not in src and "--allow-dirty" not in src
    assert '"worktree", "add", "--detach"' in src
    assert release.build_parser().parse_args(["--ref", "v1.0.0"]).ref == "v1.0.0"


GIT_REMOTE_V = """origin\thttps://github.com/samcrow92/the-flash-master (fetch)
origin\thttps://github.com/samcrow92/the-flash-master (push)
corporate\thttps://forvia-hella.ghe.com/team/the-flash-master.git (fetch)
corporate\thttps://forvia-hella.ghe.com/team/the-flash-master.git (push)
"""


def test_lists_every_remote():
    remotes = release.parse_remotes(GIT_REMOTE_V)
    assert list(remotes) == ["origin", "corporate"]
    assert release.describe_remote(remotes["corporate"]) == "forvia-hella.ghe.com/team/the-flash-master"


def test_choose_remote(monkeypatch, capsys):
    remotes = release.parse_remotes(GIT_REMOTE_V)
    assert release.choose_remote(remotes, "corporate", interactive=True) == "corporate"
    with pytest.raises(ReleaseError, match="have: origin, corporate"):
        release.choose_remote(remotes, "upstream", interactive=False)
    ui = release.UI(False)
    assert release.choose_remote(remotes, None, interactive=False, ui=ui) == "origin"  # --yes / piped: origin
    assert release.choose_remote({"corporate": "x"}, None, interactive=True, ui=ui) == "corporate"  # only one: no question
    answers = iter(["7", "2"])
    monkeypatch.setattr("builtins.input", lambda _prompt: next(answers))
    assert release.choose_remote(remotes, None, interactive=True, ui=ui) == "corporate"
    out = capsys.readouterr().out
    assert "1) origin" in out and "2) corporate" in out and "forvia-hella.ghe.com/team/the-flash-master" in out
    monkeypatch.setattr("builtins.input", lambda _prompt: "")
    assert release.choose_remote(remotes, None, interactive=True, ui=ui) == "origin"  # Enter = origin
