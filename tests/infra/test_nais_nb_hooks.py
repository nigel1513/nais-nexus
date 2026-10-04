"""infra/notebook/nais_nb_hooks.py: per-project git history of the shared JupyterLab (runs against a real git)."""

import importlib.util
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")

MODULE_PATH = Path(__file__).resolve().parents[2] / "infra" / "notebook" / "nais_nb_hooks.py"
U = "00000000-0000-4000-8000-00000000000a"
P = "00000000-0000-4000-8000-00000000000b"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("nais_nb_hooks_under_test", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def hooks(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    module = _load()
    setattr(module, "submit", lambda fn, *args: fn(*args))  # noqa: B010  # inline, not the background thread
    # A clean environment: no global identity, so only the repo-local one can make commits work.
    monkeypatch.setenv("HOME", "/nonexistent-home")
    monkeypatch.delenv("GIT_AUTHOR_NAME", raising=False)
    monkeypatch.delenv("GIT_AUTHOR_EMAIL", raising=False)
    monkeypatch.delenv("EMAIL", raising=False)
    yield module


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    (tmp_path / "work" / U / P / "data").mkdir(parents=True)
    return tmp_path


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "core.quotepath=false", *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()


def log(repo: Path) -> list[str]:
    return git(repo, "log", "--format=%s").splitlines()


def test_project_dir_of_accepts_uuid_folders_only(hooks: Any, root: Path) -> None:
    work = root / "work"
    assert hooks.project_dir_of(work / U / P / "a.ipynb", work) == (work / U / P).resolve()
    assert hooks.project_dir_of(work / U / P / "sub" / "b.ipynb", work) == (work / U / P).resolve()
    assert hooks.project_dir_of(work / U / "a.ipynb", work) is None
    assert hooks.project_dir_of(work / "x" / P / "a.ipynb", work) is None
    assert hooks.project_dir_of(root / "other.ipynb", work) is None
    assert hooks.project_dir_of(work / U / P / ".." / ".." / "a.ipynb", work) is None


def test_ensure_repo_sets_up_history_identity_and_nbdime(hooks: Any, root: Path) -> None:
    repo = root / "work" / U / P
    (repo / "README.md").write_text("# 프로젝트\n", encoding="utf-8")
    (repo / "data" / "big.csv").write_text("a,b\n1,2\n", encoding="utf-8")
    (repo / "old.ipynb").write_text("{}", encoding="utf-8")
    assert hooks.ensure_repo(repo, "홍길동\n<x>") is True
    assert log(repo) == [hooks.INITIAL_MESSAGE]
    assert set(git(repo, "ls-files").splitlines()) == {
        ".gitattributes",
        ".gitignore",
        "README.md",
        "old.ipynb",
    }
    assert git(repo, "config", "--local", "user.name") == "홍길동 x"
    assert git(repo, "config", "--local", "user.email") == f"{U}@nais.local"
    assert git(repo, "log", "-1", "--format=%an <%ae>") == f"홍길동 x <{U}@nais.local>"
    assert git(repo, "config", "--local", "diff.jupyternotebook.command") == "git-nbdiffdriver diff"
    assert (
        git(repo, "config", "--local", "merge.jupyternotebook.driver")
        == "git-nbmergedriver merge %O %A %B %L %P"
    )
    assert (repo / ".gitattributes").read_text() == "*.ipynb diff=jupyternotebook merge=jupyternotebook\n"
    gitignore = (repo / ".gitignore").read_text(encoding="utf-8")
    for pattern in ("data/", ".ipynb_checkpoints/", "*.csv", "*.parquet"):
        assert pattern in gitignore.splitlines()
    assert git(repo, "rev-parse", "--abbrev-ref", "HEAD") == "main"
    # Idempotent; a new display name is applied, the e-mail stays the placeholder.
    assert hooks.ensure_repo(repo, "김연구") is False
    assert log(repo) == [hooks.INITIAL_MESSAGE]
    assert git(repo, "config", "--local", "user.name") == "김연구"
    assert hooks.ensure_repo(repo) is False
    assert git(repo, "config", "--local", "user.name") == "김연구"


def test_ensure_repo_without_a_name_uses_the_user_id(hooks: Any, root: Path) -> None:
    repo = root / "work" / U / P
    hooks.ensure_repo(repo)
    assert git(repo, "config", "--local", "user.name") == U


def test_commit_saved_commits_changes_of_the_saved_file_only(hooks: Any, root: Path) -> None:
    work = root / "work"
    repo = work / U / P
    nb = repo / "analysis.ipynb"
    nb.write_text('{"cells": []}', encoding="utf-8")
    # The first save lazily creates the repository; its first commit already holds the file.
    assert hooks.commit_saved(nb, work) is None
    assert log(repo) == [hooks.INITIAL_MESSAGE]
    assert "analysis.ipynb" in git(repo, "ls-files").splitlines()
    nb.write_text('{"cells": [1]}', encoding="utf-8")
    other = repo / "notes.py"
    other.write_text("x = 1\n", encoding="utf-8")
    git(repo, "add", "notes.py")  # the user's own staged work is not swept into the auto commit
    assert hooks.commit_saved(nb, work)
    assert log(repo)[0] == "save: analysis.ipynb"
    assert git(repo, "show", "--name-only", "--format=", "HEAD") == "analysis.ipynb"
    assert "notes.py" in git(repo, "diff", "--cached", "--name-only")
    # Unchanged save, ignored files and anything outside a project folder: no commit.
    count = len(log(repo))
    assert hooks.commit_saved(nb, work) is None
    (repo / "data" / "x.csv").write_text("1", encoding="utf-8")
    assert hooks.commit_saved(repo / "data" / "x.csv", work) is None
    (repo / "t.parquet").write_bytes(b"PAR1")
    assert hooks.commit_saved(repo / "t.parquet", work) is None
    (work / U / "loose.ipynb").write_text("{}", encoding="utf-8")
    assert hooks.commit_saved(work / U / "loose.ipynb", work) is None
    assert len(log(repo)) == count
    sub = repo / "exp"
    sub.mkdir()
    (sub / "b.ipynb").write_text("{}", encoding="utf-8")
    assert hooks.commit_saved(sub / "b.ipynb", work)
    assert log(repo)[0] == "save: exp/b.ipynb"
    korean = repo / "실험 노트.ipynb"  # researchers' own file names may be Korean
    korean.write_text("{}", encoding="utf-8")
    assert hooks.commit_saved(korean, work)
    assert log(repo)[0] == "save: 실험 노트.ipynb"


def test_commit_saved_skips_files_over_the_cap(
    hooks: Any, root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    work = root / "work"
    repo = work / U / P
    assert hooks.MAX_COMMIT_BYTES == 10 * 1024 * 1024
    monkeypatch.setattr(hooks, "MAX_COMMIT_BYTES", 10)
    big = repo / "big.ipynb"
    big.write_text("x" * 11, encoding="utf-8")
    assert hooks.commit_saved(big, work) is None
    assert not (repo / ".git").exists()


def test_media_is_ignored(hooks: Any, root: Path) -> None:
    work = root / "work"
    repo = work / U / P
    hooks.ensure_repo(repo)
    for name in ("plot.png", "clip.mp4", "paper.pdf", "photo.JPG".lower()):
        (repo / name).write_bytes(b"x")
        assert hooks.commit_saved(repo / name, work) is None
    assert git(repo, "ls-files").splitlines() == [".gitattributes", ".gitignore"]


@pytest.mark.parametrize("name", ["*", ":(exclude)x", "*.ipynb", ":(glob)**", ":!mine.py"])
def test_file_names_are_literal_pathspecs(
    hooks: Any, root: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    work = root / "work"
    repo = work / U / P
    hooks.ensure_repo(repo)
    monkeypatch.setattr(hooks, "MAX_COMMIT_BYTES", 100)
    (repo / "other.ipynb").write_text("{}", encoding="utf-8")  # untracked, must stay so
    (repo / "big.ipynb").write_text("x" * 200, encoding="utf-8")  # over the cap, must never be staged
    staged = repo / "mine.py"
    staged.write_text("x = 1\n", encoding="utf-8")
    git(repo, "add", "mine.py")  # someone's staged work stays staged, out of the auto commit
    saved = repo / name
    saved.write_text("{}", encoding="utf-8")
    assert hooks.commit_saved(saved, work)
    assert git(repo, "show", "--name-only", "--format=", "HEAD").splitlines() == [name]
    assert log(repo)[0] == f"save: {name}"
    assert git(repo, "diff", "--cached", "--name-only").splitlines() == ["mine.py"]
    tracked = git(repo, "ls-files").splitlines()
    assert "other.ipynb" not in tracked and "big.ipynb" not in tracked


def test_no_command_from_the_folder_runs_during_a_save(hooks: Any, root: Path) -> None:
    """A kernel can write any folder's .git/config and .gitattributes: the hook's git must run none of it."""
    work = root / "work"
    repo = work / U / P
    hooks.ensure_repo(repo)
    marker = root / "PWNED"
    (repo / ".gitattributes").write_text("* filter=evil diff=evil\n", encoding="utf-8")
    git(repo, "config", "filter.evil.clean", f"touch {marker}; cat")
    git(repo, "config", "filter.evil.process", f"sh -c 'touch {marker}'")
    git(repo, "config", "filter.evil.required", "true")
    git(repo, "config", "diff.evil.textconv", f"touch {marker}; cat")
    git(repo, "config", "core.fsmonitor", f"touch {marker}; true")
    hook = repo / ".git" / "hooks" / "post-commit"
    hook.write_text(f"#!/bin/sh\ntouch {marker}\n", encoding="utf-8")
    hook.chmod(0o755)
    pre = repo / ".git" / "hooks" / "pre-commit"
    pre.write_text(f"#!/bin/sh\ntouch {marker}\nexit 1\n", encoding="utf-8")
    pre.chmod(0o755)
    nb = repo / "a.ipynb"
    nb.write_text('{"cells": []}', encoding="utf-8")
    assert hooks.commit_saved(nb, work)
    nb.write_text('{"cells": [1]}', encoding="utf-8")
    assert hooks.commit_saved(nb, work)
    assert not marker.exists()
    assert git(repo, "show", "HEAD:a.ipynb") == '{"cells": [1]}'


def test_index_lock_is_retried_once(hooks: Any, root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    work = root / "work"
    repo = work / U / P
    hooks.ensure_repo(repo)
    lock = repo / ".git" / "index.lock"
    lock.write_text("", encoding="utf-8")
    monkeypatch.setattr(hooks.time, "sleep", lambda _s: lock.unlink())  # the Git panel finishes meanwhile
    nb = repo / "a.ipynb"
    nb.write_text("{}", encoding="utf-8")
    assert hooks.commit_saved(nb, work)
    lock.write_text("", encoding="utf-8")
    monkeypatch.setattr(
        hooks.time, "sleep", lambda _s: None
    )  # still locked: the save logs, the next one commits
    nb.write_text('{"x": 1}', encoding="utf-8")
    with pytest.raises(subprocess.CalledProcessError):
        hooks.commit_saved(nb, work)


def manager(root: Path) -> SimpleNamespace:
    return SimpleNamespace(root_dir=str(root))


def test_hooks_read_the_portal_keys_and_never_raise(hooks: Any, root: Path) -> None:
    repo = root / "work" / U / P
    cm = manager(root)
    readme = repo / "README.md"
    model: dict[str, Any] = {"type": "file", "content": "# x", "nais_author_name": "홍길동"}
    hooks.pre_save_hook(model=model, path=f"work/{U}/{P}/README.md", contents_manager=cm)
    assert "nais_author_name" not in model  # never reaches the file model
    assert git(repo, "config", "--local", "user.name") == "홍길동"
    readme.write_text("# x\n", encoding="utf-8")
    hooks.post_save_hook(model={"type": "file"}, os_path=str(readme), contents_manager=cm)
    assert "README.md" in git(repo, "ls-files").splitlines()

    # The starter notebook: committed, but not "saved today" for the research-note draft.
    starter = repo / "analysis.ipynb"
    model = {"type": "notebook", "content": {}, "nais_starter": True}
    hooks.pre_save_hook(model=model, path=f"/work/{U}/{P}/analysis.ipynb", contents_manager=cm)
    assert "nais_starter" not in model
    starter.write_text("{}", encoding="utf-8")
    hooks.post_save_hook(model={"type": "notebook"}, os_path=str(starter), contents_manager=cm)
    assert time.time() - starter.stat().st_mtime > 24 * 3600
    assert log(repo)[0] == "save: analysis.ipynb"
    # The next (real) save keeps its own time.
    starter.write_text('{"cells": []}', encoding="utf-8")
    hooks.post_save_hook(model={"type": "notebook"}, os_path=str(starter), contents_manager=cm)
    assert time.time() - starter.stat().st_mtime < 3600

    # A starter mark whose save failed before post-save is cleared by the next save without the flag.
    hooks.pre_save_hook(
        model={"type": "notebook", "nais_starter": True}, path=f"work/{U}/{P}/b.ipynb", contents_manager=cm
    )
    assert str((repo / "b.ipynb").resolve()) in hooks._starters
    hooks.pre_save_hook(model={"type": "notebook"}, path=f"work/{U}/{P}/b.ipynb", contents_manager=cm)
    assert hooks._starters == set()
    (repo / "b.ipynb").write_text("{}", encoding="utf-8")
    hooks.post_save_hook(model={"type": "notebook"}, os_path=str(repo / "b.ipynb"), contents_manager=cm)
    assert time.time() - (repo / "b.ipynb").stat().st_mtime < 3600

    # Directories, odd input and git failures never raise into the save path.
    hooks.post_save_hook(model={"type": "directory"}, os_path=str(repo / "data"), contents_manager=cm)
    hooks.pre_save_hook(model=None, path="x", contents_manager=cm)
    hooks.post_save_hook(model=None, os_path="", contents_manager=None)

    def boom(*_: object) -> None:
        raise RuntimeError("git broke")

    hooks.submit = boom
    hooks.post_save_hook(model={"type": "file"}, os_path=str(readme), contents_manager=cm)


def test_background_runner_logs_failures(hooks: Any, root: Path) -> None:
    done: list[str] = []
    hooks._background(lambda: done.append("ok"))
    hooks._background(lambda: (_ for _ in ()).throw(RuntimeError("x")))
    hooks._background(lambda: done.append("after"))
    assert hooks._executor is not None
    hooks._executor.shutdown(wait=True)
    assert done == ["ok", "after"]


def test_age_starter_moves_mtime_back(hooks: Any, tmp_path: Path) -> None:
    f = tmp_path / "a.ipynb"
    f.write_text("{}", encoding="utf-8")
    hooks.age_starter(f)
    assert time.time() - os.stat(f).st_mtime >= hooks.STARTER_AGE_S - 5
