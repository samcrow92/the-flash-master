import tarfile

from flashadmin import ops
from test_packaging import make_root


class FakeSession:
    def __init__(self, output):
        self.output = output
        self.cmds = []
        self.uploaded = {}

    def mktemp_dir(self):
        return "/tmp/flash-admin.T"

    def put(self, local, remote, progress=None):
        with tarfile.open(local) as tar:
            self.uploaded[remote] = tar.getnames()
        if progress:
            progress(10, 10)

    def exec(self, cmd, sudo=False, sudo_user=None, on_line=None, **kw):
        self.cmds.append((cmd, sudo, sudo_user))
        if "install.sh" in cmd:
            for line in self.output.splitlines():
                on_line(line)
            return 0, self.output
        return 0, ""


def test_install_server_returns_token(tmp_path):
    root = make_root(tmp_path)
    s = FakeSession('[install] ok\n{"adminToken": "fs_admin", "url": "http://127.0.0.1:8787"}')
    lines = []
    res = ops.install_server(s, str(root), port=8787, bind_public=True, on_line=lines.append)
    assert res["adminToken"] == "fs_admin"
    assert "deploy/install.sh" in s.uploaded["/tmp/flash-admin.T/flash-server.tar.gz"]
    install = [c for c in s.cmds if "install.sh" in c[0]][0]
    assert install[1] is True and "--host 0.0.0.0 --port 8787" in install[0]
    assert any(c[0].startswith("rm -rf") for c in s.cmds)  # temp dir cleaned
    assert "[install] ok" in lines


def test_run_cli_runs_as_service_user_and_parses_json():
    class S(FakeSession):
        def exec(self, cmd, sudo=False, sudo_user=None, on_line=None, **kw):
            self.cmds.append((cmd, sudo, sudo_user))
            return 0, 'x\n{"imported": 3}'

    s = S("")
    assert ops.run_cli(s, "import-marketplace", "/tmp/p") == {"imported": 3}
    assert s.cmds[0][1] is True and s.cmds[0][2] == "flash"
