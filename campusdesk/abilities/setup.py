"""Assembly for optional Python workbench abilities."""

import os
from pathlib import Path
import re

from . import Abilities
from .qq import QQ, QQSettings
from .search import Search
from ..workspace import WorkspaceError, read_config


def load_abilities(root: Path, provider: str | None, qq: bool, history_suggestions: bool) -> Abilities:
    runtime = Abilities()
    if provider:
        key = os.getenv("BRAVE_SEARCH_API_KEY", "")
        if provider == "brave" and not key:
            runtime.unavailable["web.search"] = Search.spec
        else:
            runtime.register(Search(provider, key))
    if qq:
        try:
            config = read_config(root)
            account = str(config.get("account_id", ""))
            api_token = config.get("token")
            callback_token = os.getenv("CAMPUSDESK_QQ_CALLBACK_TOKEN") or api_token
            if (not re.fullmatch(r"[0-9]{1,20}", account) or not isinstance(api_token, str)
                    or len(api_token) < 16 or not isinstance(callback_token, str) or len(callback_token) < 16):
                raise ValueError()
            runtime.register(QQ(root, QQSettings(account, api_token, callback_token,
                                                history_suggestions=history_suggestions)))
        except (ValueError, WorkspaceError):
            runtime.unavailable["qq.listen"] = QQ.spec
    return runtime
