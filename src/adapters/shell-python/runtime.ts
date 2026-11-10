/**
 * The standard runtime every generated Python script carries (section 11):
 * config loading, rotating logs, central error capture and the failure email.
 * It is emitted verbatim by the mock converter and given to the real model as
 * the block it must reproduce, so validators and tests see one implementation.
 */
export const RUNTIME_VERSION = '1.0.0';

export interface RuntimeFeatures {
  db: boolean;
  ssh: boolean;
  ftp: boolean;
  mail: boolean;
  cmd: boolean;
}

export function runtimeImports(f: RuntimeFeatures, extra: string[] = []): string {
  const std = new Set<string>([
    'import argparse',
    'import configparser',
    'import logging',
    'import os',
    'import smtplib',
    'import socket',
    'import sys',
    'import time',
    'import traceback',
    'import uuid',
    'from collections import deque',
    'from dataclasses import dataclass, field',
    'from datetime import datetime',
    'from email.message import EmailMessage',
    'from logging.handlers import RotatingFileHandler',
    'from pathlib import Path',
    'from typing import Any, Callable, Optional, Sequence',
    ...extra,
  ]);
  if (f.cmd) std.add('import subprocess');
  if (f.ftp) std.add('import ftplib');
  const third: string[] = [];
  if (f.db) third.push('import oracledb');
  if (f.ssh) third.push('import paramiko');
  const sortKey = (s: string) => s.replace(/^from /, 'import ');
  return [...std].sort((a, b) => sortKey(a).localeCompare(sortKey(b))).join('\n') + (third.length ? '\n\n' + third.join('\n') : '');
}

const CORE = String.raw`
SCRIPT_NAME = Path(__file__).name
OPS_EMAIL = "ops@script.com"
LOG_MAX_BYTES = 10 * 1024 * 1024
LOG_BACKUP_COUNT = 5
LOG_TAIL_LINES = 50

LOG = logging.getLogger(SCRIPT_NAME)


class ScriptError(Exception):
    """A failure with the exit code the scheduler must see."""

    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class CommandError(ScriptError):
    """An external command failed."""

    def __init__(self, name: str, returncode: int, stderr_tail: str) -> None:
        super().__init__(f"{name} exited with code {returncode}", returncode if 0 < returncode < 256 else 1)
        self.name = name
        self.returncode = returncode
        self.stderr_tail = stderr_tail


class TailHandler(logging.Handler):
    """Keeps the last log lines for the failure email."""

    def __init__(self, size: int) -> None:
        super().__init__()
        self.lines: deque[str] = deque(maxlen=size)

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(self.format(record))


@dataclass
class RunState:
    """Everything one execution needs; passed explicitly, never global."""

    cfg: configparser.ConfigParser
    run_id: str
    started: datetime
    tail: TailHandler
    strict: bool = False
    last_error: Optional[dict[str, Any]] = None
    resources: dict[str, Any] = field(default_factory=dict)


def load_config(path: Optional[str]) -> configparser.ConfigParser:
    """Reads the config file named by --config or SCRIPT_CONFIG."""
    cfg = configparser.ConfigParser(interpolation=None)
    chosen = path or os.environ.get("SCRIPT_CONFIG")
    if chosen:
        if not Path(chosen).is_file():
            raise ScriptError(f"Config file not found: {chosen}", 2)
        cfg.read(chosen)
    return cfg


def get_setting(cfg: configparser.ConfigParser, section: str, key: str, default: Optional[str] = None) -> str:
    value = cfg.get(section, key, fallback=default)
    if value is None or value == "" or value == "CHANGE_ME":
        raise ScriptError(f"Missing setting [{section}] {key}: set it in the config file", 2)
    return value


def get_password(cfg: configparser.ConfigParser, section: str, env_name: str) -> str:
    """Environment variable first, then the config file. Never logged."""
    value = os.environ.get(env_name) or cfg.get(section, "password", fallback="")
    if not value or value == "CHANGE_ME":
        raise ScriptError(f"Missing password: set {env_name} or [{section}] password", 2)
    return value


def env(name: str, cfg: configparser.ConfigParser, default: Optional[str] = None) -> str:
    """Environment variable with a config fallback ([env] section) and a clear error."""
    value = os.environ.get(name)
    if value is None or value == "":
        value = cfg.get("env", name, fallback=default)
    if value is None:
        raise ScriptError(f"Environment variable {name} is not set (and [env] {name} is not in the config file)", 2)
    return value


def setup_logging(cfg: configparser.ConfigParser, run_id: str) -> TailHandler:
    log_dir = Path(cfg.get("logging", "log_dir", fallback="."))
    log_dir.mkdir(parents=True, exist_ok=True)
    level = getattr(logging, cfg.get("logging", "level", fallback="INFO").upper(), logging.INFO)
    fmt = logging.Formatter(f"%(asctime)s %(levelname)s {run_id} %(filename)s:%(lineno)d %(message)s")
    file_handler = RotatingFileHandler(log_dir / f"{Path(SCRIPT_NAME).stem}.log", maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT)
    console = logging.StreamHandler()
    tail = TailHandler(LOG_TAIL_LINES)
    LOG.handlers.clear()
    for handler in (file_handler, console, tail):
        handler.setFormatter(fmt)
        LOG.addHandler(handler)
    LOG.setLevel(level)
    LOG.propagate = False
    return tail


def build_error_record(exc: BaseException) -> dict[str, Any]:
    """Line number and message first: where the script failed and why."""
    frames = traceback.extract_tb(exc.__traceback__)
    here = os.path.abspath(__file__)
    own = [f for f in frames if os.path.abspath(f.filename) == here]
    frame = own[-1] if own else (frames[-1] if frames else None)
    record: dict[str, Any] = {
        "line": frame.lineno if frame else None,
        "message": str(exc),
        "type": type(exc).__name__,
        "file": SCRIPT_NAME,
        "function": frame.name if frame else None,
        "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
    }
    for key in ("statement_label", "statement_line", "oracle_code", "oracle_message", "dbms_output"):
        if hasattr(exc, key):
            record[key] = getattr(exc, key)
    if isinstance(exc, CommandError):
        record["command"] = exc.name
        record["command_exit_code"] = exc.returncode
        record["stderr_tail"] = exc.stderr_tail
    return record


def format_error_record(record: dict[str, Any]) -> str:
    head = f"line={record.get('line')} message={record.get('message')} type={record.get('type')} file={record.get('file')} function={record.get('function')}"
    extra = " ".join(f"{k}={record[k]}" for k in ("statement_label", "statement_line", "oracle_code", "oracle_message", "dbms_output", "command", "command_exit_code", "stderr_tail") if record.get(k) not in (None, ""))
    return head + (" " + extra if extra else "")


def log_handled(state: RunState, exc: BaseException, what: str) -> None:
    """A failure the script survives: logged at WARNING with line and message."""
    record = build_error_record(exc)
    state.last_error = record
    LOG.warning("%s failed: %s", what, format_error_record(record))


def send_failure_email(state: RunState, record: dict[str, Any], exit_code: int) -> None:
    """Never raises: a failed email must not change the exit code."""
    try:
        cfg = state.cfg
        msg = EmailMessage()
        msg["Subject"] = f"{SCRIPT_NAME} FAILED line {record.get('line')} run {state.run_id}"
        msg["From"] = cfg.get("smtp", "sender", fallback=OPS_EMAIL)
        msg["To"] = OPS_EMAIL
        body = [
            format_error_record(record),
            "",
            f"exit code: {exit_code}",
            f"host: {cfg.get('source', 'host', fallback=socket.gethostname())}",
            f"started: {state.started.isoformat(timespec='seconds')}",
            f"ended: {datetime.now().isoformat(timespec='seconds')}",
            "",
            "Traceback:",
            str(record.get("traceback") or "(none)"),
            f"Last {LOG_TAIL_LINES} log lines:",
            *state.tail.lines,
        ]
        msg.set_content("\n".join(body))
        with smtplib.SMTP(get_setting(cfg, "smtp", "host"), cfg.getint("smtp", "port", fallback=25), timeout=30) as smtp:
            smtp.send_message(msg)
        LOG.info("Failure email sent to %s", OPS_EMAIL)
    except Exception as mail_exc:  # noqa: BLE001 - reporting must not mask the original failure
        LOG.error("Could not send failure email: %s", mail_exc)


def step(state: RunState, what: str, func: Callable[..., Any], *args: Any, **kwargs: Any) -> int:
    """Runs one step and returns its status like the shell's $?. In strict mode (set -e) failures propagate."""
    began = time.monotonic()
    try:
        result = func(*args, **kwargs)
        LOG.info("%s finished in %.1fs", what, time.monotonic() - began)
        return result if isinstance(result, int) and not isinstance(result, bool) else 0
    except Exception as exc:  # noqa: BLE001 - mirrors the shell continuing after a failed command
        if state.strict:
            raise
        log_handled(state, exc, what)
        return exc.exit_code if isinstance(exc, ScriptError) else 1
`;

const CMD = String.raw`

def run_command(args: Sequence[str], timeout: int = 3600, stdout_path: Optional[str] = None, append: bool = False, stdin_path: Optional[str] = None, env_extra: Optional[dict[str, str]] = None) -> str:
    """Runs an external program without a shell. Output goes to the log (or to a file when redirected)."""
    name = Path(args[0]).name
    LOG.info("Running %s (%d arguments)", name, len(args) - 1)
    stdin = open(stdin_path, "rb") if stdin_path else None
    try:
        proc = subprocess.run(list(args), shell=False, check=True, timeout=timeout, capture_output=True, stdin=stdin, env={**os.environ, **(env_extra or {})})
    except subprocess.CalledProcessError as exc:
        tail = "\n".join((exc.stderr or b"").decode(errors="replace").splitlines()[-20:])
        raise CommandError(name, exc.returncode, tail) from exc
    except subprocess.TimeoutExpired as exc:
        raise CommandError(name, 124, f"timed out after {timeout}s") from exc
    finally:
        if stdin:
            stdin.close()
    out = proc.stdout.decode(errors="replace")
    if stdout_path:
        with open(stdout_path, "a" if append else "w", encoding="utf-8") as handle:
            handle.write(out)
    else:
        for line in out.splitlines():
            LOG.info("%s: %s", name, line)
    for line in proc.stderr.decode(errors="replace").splitlines():
        LOG.info("%s (stderr): %s", name, line)
    return out


def run_pipeline(commands: Sequence[Sequence[str]], timeout: int = 3600, stdout_path: Optional[str] = None, append: bool = False) -> str:
    """Runs cmd1 | cmd2 | ... without a shell. The status is the last command's, as in sh."""
    procs: list[subprocess.Popen[bytes]] = []
    previous = None
    for args in commands:
        proc = subprocess.Popen(list(args), shell=False, stdin=previous, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if previous is not None:
            previous.close()
        previous = proc.stdout
        procs.append(proc)
    try:
        out_bytes, err_bytes = procs[-1].communicate(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        for proc in procs:
            proc.kill()
        raise CommandError(Path(commands[-1][0]).name, 124, f"timed out after {timeout}s") from exc
    for proc in procs[:-1]:
        proc.wait()
    name = Path(commands[-1][0]).name
    if procs[-1].returncode != 0:
        raise CommandError(name, procs[-1].returncode, "\n".join(err_bytes.decode(errors="replace").splitlines()[-20:]))
    out = out_bytes.decode(errors="replace")
    if stdout_path:
        with open(stdout_path, "a" if append else "w", encoding="utf-8") as handle:
            handle.write(out)
    else:
        for line in out.splitlines():
            LOG.info("%s: %s", name, line)
    return out
`;

const DB = String.raw`

class SqlError(ScriptError):
    """A database error with the Oracle code, message and the line inside the statement."""

    def __init__(self, label: str, statement: str, error: Any, dbms_output: str, exit_code: int = 1) -> None:
        offset = getattr(error, "offset", 0) or 0
        self.statement_label = label
        self.statement_line = statement.count("\n", 0, offset) + 1
        self.oracle_code = getattr(error, "full_code", None) or getattr(error, "code", None)
        self.oracle_message = str(getattr(error, "message", error)).strip()
        self.dbms_output = dbms_output
        super().__init__(f"{label}: {self.oracle_message} (statement line {self.statement_line})", exit_code)


def db_connect(state: RunState) -> Any:
    """One connection per run, reused by every statement."""
    if "db" not in state.resources:
        cfg = state.cfg
        state.resources["db"] = oracledb.connect(user=get_setting(cfg, "database", "user"), password=get_password(cfg, "database", "DB_PASSWORD"), dsn=get_setting(cfg, "database", "dsn"))
        LOG.info("Connected to the database")
    return state.resources["db"]


def read_dbms_output(cursor: Any) -> list[str]:
    chunk = 100
    lines_var = cursor.arrayvar(str, chunk)
    count_var = cursor.var(int)
    count_var.setvalue(0, chunk)
    lines: list[str] = []
    while True:
        cursor.callproc("dbms_output.get_lines", (lines_var, count_var))
        count = count_var.getvalue()
        lines.extend(line or "" for line in lines_var.getvalue()[:count])
        if count < chunk:
            return lines


def run_sql(state: RunState, label: str, statement: str, binds: Optional[dict[str, Any]] = None, spool: Any = None, colsep: str = " ", heading: bool = True, is_plsql: bool = False, exit_on_error: Optional[int] = None) -> int:
    """Runs one statement with bind variables. Mirrors SQL*Plus: errors are fatal only under WHENEVER SQLERROR EXIT."""
    conn = db_connect(state)
    rows = 0
    with conn.cursor() as cursor:
        cursor.arraysize = 1000
        cursor.prefetchrows = 1001
        cursor.callproc("dbms_output.enable", (None,))
        try:
            cursor.execute(statement, binds or {})
            if cursor.description:
                if spool is not None and heading:
                    spool.write(colsep.join(col[0] for col in cursor.description) + "\n")
                for row in cursor:
                    rows += 1
                    if spool is not None:
                        spool.write(colsep.join("" if value is None else str(value) for value in row) + "\n")
            else:
                rows = cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0
            for line in read_dbms_output(cursor):
                LOG.info("DBMS_OUTPUT: %s", line)
                if spool is not None:
                    spool.write(line + "\n")
        except oracledb.Error as exc:
            (error,) = exc.args
            try:
                captured = " ".join(line for line in read_dbms_output(cursor) if line.startswith("ERROR|"))
            except oracledb.Error:
                captured = ""
            failure = SqlError(label, statement, error, captured, exit_on_error or 1)
            if exit_on_error is None:
                try:
                    raise failure from exc
                except SqlError as handled:
                    log_handled(state, handled, label)
                return 0
            raise failure from exc
    LOG.info("%s: %d row(s)", label, rows)
    return rows
`;

const SSH = String.raw`

def ssh_client(state: RunState, section: str) -> Any:
    """One SSH session per remote host, reused for every command and transfer. Host keys are verified."""
    key = f"ssh:{section}"
    if key not in state.resources:
        cfg = state.cfg
        client = paramiko.SSHClient()
        client.load_system_host_keys()
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
        password = os.environ.get(f"{section.upper()}_PASSWORD") or cfg.get(section, "password", fallback="") or None
        client.connect(get_setting(cfg, section, "host"), port=cfg.getint(section, "port", fallback=22), username=get_setting(cfg, section, "user"), password=None if password == "CHANGE_ME" else password, key_filename=cfg.get(section, "key_file", fallback=None), timeout=60)
        state.resources[key] = client
        LOG.info("SSH session opened ([%s])", section)
    return state.resources[key]


def sftp_client(state: RunState, section: str) -> Any:
    key = f"sftp:{section}"
    if key not in state.resources:
        state.resources[key] = ssh_client(state, section).open_sftp()
    return state.resources[key]


def remote_command(state: RunState, section: str, command: str, timeout: int = 3600) -> str:
    _stdin, stdout, stderr = ssh_client(state, section).exec_command(command, timeout=timeout)
    status = stdout.channel.recv_exit_status()
    out = stdout.read().decode(errors="replace")
    for line in out.splitlines():
        LOG.info("remote: %s", line)
    if status != 0:
        raise CommandError("ssh", status, "\n".join(stderr.read().decode(errors="replace").splitlines()[-20:]))
    return out


def sftp_put(state: RunState, section: str, local: str, remote: str) -> None:
    target = remote if not remote.endswith("/") else remote + Path(local).name
    sftp_client(state, section).put(local, target)
    LOG.info("Uploaded 1 file (%d bytes)", Path(local).stat().st_size)


def sftp_get(state: RunState, section: str, remote: str, local: str) -> None:
    target = local if not Path(local).is_dir() else str(Path(local) / Path(remote).name)
    sftp_client(state, section).get(remote, target)
    LOG.info("Downloaded 1 file (%d bytes)", Path(target).stat().st_size)
`;

const FTP = String.raw`

def ftp_session(state: RunState, section: str) -> Any:
    """FTP is kept because the source used it; it is not encrypted (see SHELL_FTP_INSECURE)."""
    key = f"ftp:{section}"
    if key not in state.resources:
        cfg = state.cfg
        ftp = ftplib.FTP(timeout=60)
        ftp.connect(get_setting(cfg, section, "host"), cfg.getint(section, "port", fallback=21))
        ftp.login(get_setting(cfg, section, "user"), get_password(cfg, section, f"{section.upper()}_PASSWORD"))
        state.resources[key] = ftp
        LOG.info("FTP session opened ([%s])", section)
    return state.resources[key]


def ftp_put(state: RunState, section: str, local: str, remote: Optional[str] = None, binary: bool = True) -> None:
    ftp = ftp_session(state, section)
    name = remote or Path(local).name
    with open(local, "rb") as handle:
        if binary:
            ftp.storbinary(f"STOR {name}", handle)
        else:
            ftp.storlines(f"STOR {name}", handle)
    LOG.info("Uploaded 1 file (%d bytes)", Path(local).stat().st_size)


def ftp_get(state: RunState, section: str, remote: str, local: Optional[str] = None) -> None:
    ftp = ftp_session(state, section)
    target = local or Path(remote).name
    with open(target, "wb") as handle:
        ftp.retrbinary(f"RETR {remote}", handle.write)
    LOG.info("Downloaded 1 file (%d bytes)", Path(target).stat().st_size)
`;

const MAIL = String.raw`

def send_mail(state: RunState, recipients: Sequence[str], subject: str, body: str = "", attachments: Sequence[str] = ()) -> None:
    cfg = state.cfg
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = cfg.get("smtp", "sender", fallback=OPS_EMAIL)
    msg["To"] = ", ".join(recipients)
    msg.set_content(body)
    for path in attachments:
        msg.add_attachment(Path(path).read_bytes(), maintype="application", subtype="octet-stream", filename=Path(path).name)
    with smtplib.SMTP(get_setting(cfg, "smtp", "host"), cfg.getint("smtp", "port", fallback=25), timeout=30) as smtp:
        smtp.send_message(msg)
    LOG.info("Mail sent to %d recipient(s)", len(recipients))
`;

const MAIN = String.raw`

def close_resources(state: RunState) -> None:
    for name, resource in reversed(list(state.resources.items())):
        try:
            if name.startswith("ftp:"):
                resource.quit()
            else:
                resource.close()
        except Exception as exc:  # noqa: BLE001
            LOG.debug("Closing %s failed: %s", name, exc)


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Central handler: runs the job, records any failure (line number and message) and emails ops."""
    args = parse_args(argv)
    run_id = uuid.uuid4().hex[:12]
    started = datetime.now()
    try:
        cfg = load_config(args.config)
        tail = setup_logging(cfg, run_id)
    except Exception as exc:  # noqa: BLE001 - logging is not available yet
        print(f"{SCRIPT_NAME} FAILED before logging started: {exc}", file=sys.stderr)
        return exc.exit_code if isinstance(exc, ScriptError) else 1
    state = RunState(cfg=cfg, run_id=run_id, started=started, tail=tail)
    LOG.info("Start %s", SCRIPT_NAME)
    exit_code = 0
    record: Optional[dict[str, Any]] = None
    try:
        exit_code = job(state, args)
        if exit_code != 0:
            record = state.last_error or {"line": None, "message": f"finished with exit code {exit_code}", "type": "ExitCode", "file": SCRIPT_NAME, "function": "job", "traceback": ""}
    except ScriptError as exc:
        record = build_error_record(exc)
        exit_code = exc.exit_code
    except Exception as exc:  # noqa: BLE001 - the central handler must see every failure
        record = build_error_record(exc)
        exit_code = 1
    finally:
        close_resources(state)
    if record is not None:
        LOG.error("FAILED %s", format_error_record(record))
        send_failure_email(state, record, exit_code)
    LOG.info("End %s exit_code=%d duration=%.1fs", SCRIPT_NAME, exit_code, (datetime.now() - started).total_seconds())
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
`;

export function runtimeCore(f: RuntimeFeatures): string {
  return CORE + (f.cmd ? CMD : '') + (f.db ? DB : '') + (f.ssh ? SSH : '') + (f.ftp ? FTP : '') + (f.mail ? MAIL : '');
}
export const RUNTIME_MAIN = MAIN;

/** Full reference runtime, shown to the real model. */
export function referenceRuntime(): string {
  const all = { db: true, ssh: true, ftp: true, mail: true, cmd: true };
  return `${runtimeImports(all)}\n${runtimeCore(all)}\n\n# parse_args(argv) and job(state, args) -> int are written per script.\n${MAIN}`;
}

export function configTemplate(sections: Map<string, Set<string>>): string {
  const order = ['source', 'target', 'database', 'smtp', 'logging', 'env'];
  const defaults: Record<string, Record<string, string>> = {
    source: { host: 'source_server', user: 'source_user', password: 'CHANGE_ME', port: '22' },
    target: { host: 'target_server', user: 'target_user', password: 'CHANGE_ME', port: '22' },
    database: { user: 'CHANGE_ME', password: 'CHANGE_ME', dsn: 'CHANGE_ME' },
    smtp: { host: 'CHANGE_ME', port: '25', sender: 'ops@script.com' },
    logging: { log_dir: 'logs', level: 'INFO' },
  };
  const lines = [
    '# config.ini template - copy to config.ini and fill in the values.',
    '# 1. Set permissions:  chmod 600 config.ini',
    '# 2. Keep config.ini out of version control (it is in .gitignore). Commit only config.ini.template.',
    '# 3. In production prefer Oracle Wallet or a secrets manager over passwords in this file.',
    '# Passwords are read from the environment first (DB_PASSWORD, SOURCE_PASSWORD, TARGET_PASSWORD), then from here.',
    '# Pass the file with --config or the SCRIPT_CONFIG environment variable.',
    '',
  ];
  const names = [...new Set([...order.filter((s) => sections.has(s) || s === 'smtp' || s === 'logging'), ...[...sections.keys()].sort()])];
  for (const s of names) {
    lines.push(`[${s}]`);
    const role = /^(source|target)(_\d+)?$/.exec(s);
    const base: Record<string, string> = role
      ? { host: `${role[1]}_server${role[2] ?? ''}`, user: `${role[1]}_user${role[2] ?? ''}`, port: '22' }
      : (defaults[s] ?? {});
    const keys = new Set<string>([...(role ? ['host', 'user'] : Object.keys(base)), ...(sections.get(s) ?? [])]);
    for (const k of keys) lines.push(`${k} = ${base[k] ?? 'CHANGE_ME'}`);
    lines.push('');
  }
  return lines.join('\n');
}
