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
