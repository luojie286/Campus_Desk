"""Errors raised by the workbench application and mapped by the API."""

class WorkbenchError(RuntimeError):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code
