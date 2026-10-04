"""Notebook history for the shared JupyterLab (M07-lite): every project folder is a small git repository.

Loaded by jupyter_server_config.py inside the `notebook` container (stock image, standard library only). The portal
prepares a folder through the Jupyter contents API only (no terminals, no exec), so the repository is made here, in the
contents manager's save hooks, the first time anything is saved in a project folder -- the README.md the portal writes
on every "노트북 열기" is such a save:

* a project folder is ``<work_root>/<user_id>/<project_id>`` with both names canonical UUIDs (``work_root`` is the
  server root's ``work/``); anything else is left alone;
* ``ensure_repo`` runs ``git init``, writes ``.gitignore`` (copied inputs, tables, large binaries, checkpoints) and
  ``.gitattributes`` (nbdime diff/merge drivers for ``*.ipynb``), sets the repo-local nbdime drivers and the author
  (display name sent by the portal, e-mail always the placeholder ``<user_id>@nais.local``, never a real address),
  and makes the first commit;
* ``commit_saved`` commits the one saved file ("save: <path>", English like every message the hook writes) when it is tracked-able (not ignored, at most 20 MB)
  and changed; other staged work of the user is left as it is (``git commit -- <file>``).

The portal sends two extra keys in a contents-API save model, read by ``pre_save_hook`` only:
``nais_author_name`` (the caller's display name) and ``nais_starter`` (the starter notebook it creates). A starter
notebook's modification time is moved two days back so that merely opening the tab never counts as "a notebook saved
today" for the research-note AI draft; the researcher's first real save makes it today's again.

The hooks never raise into the save path and never block it: git work runs on one background thread (in order, so
commits of one folder never race each other's index lock), every git call has a timeout, failures are logged.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

log = logging.getLogger("nais.nb_hooks")

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_COMMIT_BYTES = 20 * 1024 * 1024
GIT_TIMEOUT_S = 20.0
STARTER_AGE_S = 2 * 24 * 3600
EMAIL_DOMAIN = "nais.local"
INITIAL_MESSAGE = "start NAIS notebook history"

GITIGNORE = """\
# NAIS: files kept out of this folder's history (git).
# The copied inputs (data/), tables and large binaries are not versioned.
data/
.ipynb_checkpoints/
.virtual_documents/
__pycache__/
.Trash-*/
*.csv
*.tsv
*.parquet
*.feather
*.arrow
*.xlsx
*.xls
*.h5
*.hdf5
*.nc
*.pkl
*.pickle
*.joblib
*.npy
*.npz
*.zip
*.gz
*.tgz
*.tar
*.bz2
*.xz
*.7z
*.db
*.sqlite
*.pt
*.pth
*.ckpt
*.onnx
*.safetensors
*.bin
"""

GITATTRIBUTES = "*.ipynb diff=jupyternotebook merge=jupyternotebook\n"

# Repo-local settings: what `nbdime config-git --enable` sets (diff/merge drivers and tools), plus readable names.
REPO_CONFIG: tuple[tuple[str, str], ...] = (
    ("core.quotepath", "false"),  # Korean file names as they are in git output
    ("diff.jupyternotebook.command", "git-nbdiffdriver diff"),
    ("merge.jupyternotebook.driver", "git-nbmergedriver merge %O %A %B %L %P"),
    ("merge.jupyternotebook.name", "jupyter notebook merge driver"),
    ("difftool.nbdime.cmd", 'git-nbdifftool diff "$LOCAL" "$REMOTE" "$BASE"'),
    ("mergetool.nbdime.cmd", 'git-nbmergetool merge "$BASE" "$LOCAL" "$REMOTE" "$MERGED"'),
    ("mergetool.nbdime.trustExitCode", "false"),
)


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_NOSYSTEM": "1",
        "LC_ALL": "C.UTF-8",
    }
    return subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "-c", "core.quotepath=false", *args],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        timeout=GIT_TIMEOUT_S,
        check=check,
    )


def project_dir_of(os_path: str | os.PathLike[str], work_root: str | os.PathLike[str]) -> Path | None:
    """``<work_root>/<user_uuid>/<project_uuid>`` holding ``os_path`` (itself or below), else None.

    Paths are resolved, so a symlink cannot lead a save outside the project folder into its repository.
    """
    try:
        root = Path(work_root).resolve()
        rel = Path(os_path).resolve().relative_to(root)
    except (OSError, ValueError):
        return None
    parts = rel.parts
    if len(parts) < 2 or not UUID_RE.match(parts[0]) or not UUID_RE.match(parts[1]):
        return None
    return root / parts[0] / parts[1]


def clean_name(name: object, fallback: str) -> str:
    """A one-line author name (no control characters or <>), at most 100 characters; ``fallback`` when empty."""
    text = name if isinstance(name, str) else ""
    text = re.sub(r"[\x00-\x1f\x7f<>]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()[:100].strip()
    return text or fallback


def placeholder_email(project_dir: Path) -> str:
    """``<user_id>@nais.local``: the folder's user id, never a real address."""
    return f"{project_dir.parent.name}@{EMAIL_DOMAIN}"


def _config_get(repo: Path, key: str) -> str | None:
    result = _git(repo, "config", "--local", "--get", key, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def _set_identity(repo: Path, name: str | None) -> None:
    user_id = repo.parent.name
    current = _config_get(repo, "user.name")
    wanted = clean_name(name, user_id) if name is not None else (current or user_id)
    if current != wanted:
        _git(repo, "config", "--local", "user.name", wanted)
    email = placeholder_email(repo)
    if _config_get(repo, "user.email") != email:
        _git(repo, "config", "--local", "user.email", email)


def _small(path: Path) -> bool:
    try:
        return path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_COMMIT_BYTES
    except OSError:
        return False


def ensure_repo(project_dir: str | os.PathLike[str], author_name: str | None = None) -> bool:
    """Make ``project_dir`` a repository with NAIS settings; True when this call created it.

    Idempotent: an existing repository only gets missing settings and, when ``author_name`` is given, that name.
    """
    repo = Path(project_dir)
    if not repo.is_dir():
        return False
    created = not (repo / ".git").exists()
    if created:
        _git(repo, "init", "-q")
        _git(repo, "symbolic-ref", "HEAD", "refs/heads/main")
    for name, text in ((".gitignore", GITIGNORE), (".gitattributes", GITATTRIBUTES)):
        target = repo / name
        if not target.exists():
            target.write_text(text, encoding="utf-8")
    for key, value in REPO_CONFIG:
        if _config_get(repo, key) != value:
            _git(repo, "config", "--local", key, value)
    _set_identity(repo, author_name)
    if _git(repo, "rev-parse", "--verify", "-q", "HEAD", check=False).returncode != 0:
        # Everything already there that is not ignored and not over the size cap (a folder from before the history).
        listed = _git(repo, "ls-files", "-z", "--others", "--exclude-standard").stdout.split("\0")
        small = [f for f in listed if f and _small(repo / f)]
        for start in range(0, len(small), 200):
            _git(repo, "add", "--", *small[start : start + 200])
        _git(repo, "commit", "-q", "--allow-empty", "-m", INITIAL_MESSAGE)
    return created


def commit_saved(os_path: str | os.PathLike[str], work_root: str | os.PathLike[str]) -> str | None:
    """Commit the saved file in its project repository; the new commit id, or None when nothing was committed."""
    repo = project_dir_of(os_path, work_root)
    if repo is None:
        return None
    path = Path(os_path).resolve()
    if not path.is_file():
        return None
    rel = path.relative_to(repo)
    if ".git" in rel.parts:
        return None
    if path.stat().st_size > MAX_COMMIT_BYTES:
        log.info("nb history: not committed, over %d bytes: %s", MAX_COMMIT_BYTES, rel)
        return None
    ensure_repo(repo)
    name = rel.as_posix()
    if _git(repo, "check-ignore", "-q", "--", name, check=False).returncode == 0:
        return None
    _git(repo, "add", "--", name)
    if _git(repo, "diff", "--cached", "--quiet", "--", name, check=False).returncode == 0:
        return None  # saved without changes
    _git(repo, "commit", "-q", "-m", f"save: {name}", "--", name)
    return _git(repo, "rev-parse", "HEAD").stdout.strip()


def age_starter(os_path: str | os.PathLike[str], age_s: float = STARTER_AGE_S) -> None:
    """Move a just-created starter notebook's modification time ``age_s`` back (not "saved today")."""
    then = time.time() - age_s
    os.utime(os_path, (then, then))


# --- the hooks -------------------------------------------------------------------------------------------------

_executor: ThreadPoolExecutor | None = None
_executor_lock = threading.Lock()
_starters: set[str] = set()
_starters_lock = threading.Lock()


def _background(fn: Callable[..., object], *args: object) -> None:
    """Run ``fn`` on the single history thread; errors are logged, never raised."""
    global _executor

    def run() -> None:
        try:
            fn(*args)
        except Exception:
            log.warning("nb history: %s failed", getattr(fn, "__name__", "task"), exc_info=True)

    with _executor_lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="nais-nb-history")
        _executor.submit(run)


# Replaced in tests to run the work inline.
submit: Callable[..., None] = _background


def _work_root(contents_manager: Any) -> Path:
    return Path(str(getattr(contents_manager, "root_dir", "") or ".")) / "work"


def pre_save_hook(
    model: dict[str, Any] | None = None, path: str = "", contents_manager: Any = None, **_: Any
) -> None:
    """Reads the portal's ``nais_author_name`` / ``nais_starter`` keys (and drops them from the model)."""
    try:
        if not isinstance(model, dict) or contents_manager is None:
            return
        author = model.pop("nais_author_name", None)
        starter = model.pop("nais_starter", None)
        os_path = Path(str(contents_manager.root_dir)) / path.strip("/")
        repo = project_dir_of(os_path, _work_root(contents_manager))
        if repo is None:
            return
        if starter is True:
            with _starters_lock:
                _starters.add(str(os_path.resolve()))
        if isinstance(author, str):
            submit(ensure_repo, repo, author)
    except Exception:
        log.warning("nb history: pre-save hook failed", exc_info=True)


def post_save_hook(
    model: dict[str, Any] | None = None, os_path: str = "", contents_manager: Any = None, **_: Any
) -> None:
    """Queues the commit of the saved file (directories and files outside project folders are ignored)."""
    try:
        if contents_manager is None or not os_path:
            return
        if isinstance(model, dict) and model.get("type") == "directory":
            return
        key = str(Path(os_path).resolve())
        with _starters_lock:
            starter = key in _starters
            _starters.discard(key)
        if starter:
            age_starter(os_path)
        submit(commit_saved, os_path, _work_root(contents_manager))
    except Exception:
        log.warning("nb history: post-save hook failed", exc_info=True)
