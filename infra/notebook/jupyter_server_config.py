# NAIS settings for the shared JupyterLab. The compose `notebook` service mounts this folder read-only at /opt/nais
# and this file at /usr/local/etc/jupyter/jupyter_server_config.py (a system config path: the image's own
# /etc/jupyter/jupyter_server_config.py still applies, and the command-line flags in docker-compose.yml win over both).
#
# Notebook history: every project folder work/<user_id>/<project_id> becomes a git repository and each save is
# committed ("save: <path>") by the contents manager's save hooks in nais_nb_hooks.py (see its docstring).
import sys

sys.path.insert(0, "/opt/nais")

import nais_nb_hooks  # noqa: E402

c = get_config()  # type: ignore[name-defined]  # noqa: F821
c.ContentsManager.pre_save_hook = nais_nb_hooks.pre_save_hook
c.ContentsManager.post_save_hook = nais_nb_hooks.post_save_hook
