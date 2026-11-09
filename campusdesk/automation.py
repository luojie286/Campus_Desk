"""QQ policy used by the event consumer before it creates a draft todo."""

import re

ACTION = re.compile(r"报名|填写|收集|统计|接龙|问卷|作业|考试|截止|提交|名单|登记|确认|参加|会议|讲座")
DOCUMENT = re.compile(r"https://docs\.qq\.com/(?:sheet|doc)/[A-Za-z0-9_-]+", re.I)


def todo_draft(text: str) -> tuple[str, str] | None:
    """A candidate keeps the notification wording and requires user confirmation."""
    cleaned = " ".join(text.split())
    reason = "document_link" if DOCUMENT.search(cleaned) else "action_keyword" if ACTION.search(cleaned) else None
    if reason:
        return cleaned[:120], reason
    return None
