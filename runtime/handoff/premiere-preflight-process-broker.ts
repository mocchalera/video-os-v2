import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const PREMIERE_PREFLIGHT_BROKER_POLICY_VERSION = "premiere-preflight-process-broker/v2" as const;

const SHA = /^sha256:[0-9a-f]{64}$/;
const SAFE_LOCAL_PATH = /^\/[\p{L}\p{N}._/ +@()-]+$/u;
const DEFAULT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type PremierePreflightInvocation =
  | { kind: "which_ffmpeg" }
  | { kind: "which_ffprobe" }
  | { kind: "source_ffprobe"; source_path: string; source_fd: number }
  | { kind: "ready_cache_ffprobe"; media_path: string; media_fd: number; probe_mode: "output_metadata" | "packet_timing" | "frame_timing" }
  | { kind: "ffmpeg_version" }
  | { kind: "ready_cache_stream_hash"; media_path: string; media_fd: number }
  | { kind: "sysctl_exact_if_reachable" }
  | { kind: "ps_exact_if_reachable"; pid: number };

export interface PremierePreflightDiscoveryBinding {
  preflight_run_id: string;
  wrapper2_pid: number;
  discovery_sha256: string;
  tool: "ffmpeg" | "ffprobe";
  discovery_ordinal: 0 | 1;
}

export interface PremierePreflightEvaluationBinding {
  preflight_run_id: string;
  wrapper2_pid: number;
  evaluation_ordinal: number;
  track_id: string;
  clip_id: string;
  evaluation_sha256: string;
  request_sha256: string | null;
  ready_cache_generation_id: string | null;
  operation_ordinal: number;
}

export type PremierePreflightChildBinding = PremierePreflightDiscoveryBinding | PremierePreflightEvaluationBinding;

export interface PremierePreflightExecutableIdentity {
  realpath: string;
  dev: string;
  ino: string;
  mode: number;
  nlink: 1;
  size: number;
  mtime_ns: string;
  ctime_ns: string;
}

export interface PremierePreflightToolDiscoveryReceipt {
  version: "premiere-effect-bake-tool-discovery-receipt/v1";
  preflight_run_id: string;
  discovery_sha256: string;
  tool: "ffmpeg" | "ffprobe";
  discovery_ordinal: 0 | 1;
  executable_realpath: string;
  executable_identity: PremierePreflightExecutableIdentity;
  broker_invocation_receipt_sha256: string;
}

export interface PremierePreflightInvocationReceipt {
  variant: Exclude<PremierePreflightInvocation["kind"], "which_ffmpeg" | "which_ffprobe">;
  binding: PremierePreflightEvaluationBinding;
  executable_realpath: string;
  argv: string[];
  child_pid: number;
  parent_pid: number;
  exit_code: number;
  signal: string | null;
  stdout_sha256: string;
  stderr_sha256: string;
  receipt_sha256: string;
}

export interface PremierePreflightBrokerResult<Receipt extends PremierePreflightToolDiscoveryReceipt | PremierePreflightInvocationReceipt> {
  stdout: string;
  stderr: string;
  receipt: Receipt;
}

export interface PremierePreflightProcessResult {
  exit_code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  executable_realpath: string;
  argv: string[];
  child_pid: number;
  parent_pid: number;
}

export interface PremierePreflightSpawnRequest {
  executable: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  source_fd: number | null;
  shell: false;
  parent_pid: number;
}

export type PremierePreflightSpawn = (request: PremierePreflightSpawnRequest) => Promise<PremierePreflightProcessResult>;

interface BrokerOptions {
  cwd: string;
  preflight_run_id: string;
  wrapper2_pid: number;
  searchPath?: string;
  spawn?: PremierePreflightSpawn;
  realpath?: (value: string) => string;
  executableIdentity?: (value: string) => PremierePreflightExecutableIdentity;
  sourceFile?: (value: string, fd: number) => boolean;
  platform?: NodeJS.Platform;
}

function forbidden(detail: string): never {
  throw new Error(`forbidden_process: ${detail}`);
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) forbidden(`${label} fields are not exact`);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(input as object).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))) {
        output[key] = normalize((input as Record<string, unknown>)[key]);
      }
      return output;
    }
    if (typeof input === "number" && !Number.isFinite(input)) forbidden("receipt contains non-finite number");
    return Object.is(input, -0) ? 0 : input;
  };
  return JSON.stringify(normalize(value));
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}

function defaultExecutableIdentity(value: string): PremierePreflightExecutableIdentity {
  const before = fs.lstatSync(value, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size > BigInt(Number.MAX_SAFE_INTEGER) || before.mode > BigInt(Number.MAX_SAFE_INTEGER)) {
    forbidden("executable is not regular canonical nlink=1");
  }
  fs.accessSync(value, fs.constants.X_OK);
  const fd = fs.openSync(value, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const after = fs.fstatSync(fd, { bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode
      || after.nlink !== before.nlink || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      forbidden("executable identity changed while opening");
    }
    return {
      realpath: value,
      dev: String(after.dev),
      ino: String(after.ino),
      mode: Number(after.mode),
      nlink: 1,
      size: Number(after.size),
      mtime_ns: String(after.mtimeNs),
      ctime_ns: String(after.ctimeNs),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function sameExecutableIdentity(left: PremierePreflightExecutableIdentity, right: PremierePreflightExecutableIdentity): boolean {
  return canonical(left) === canonical(right);
}

function defaultSourceFile(value: string, fd: number): boolean {
  try {
    const stat = fs.lstatSync(value), descriptor = fs.fstatSync(fd);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      && fs.realpathSync(value) === value && stat.dev === descriptor.dev && stat.ino === descriptor.ino;
  } catch {
    return false;
  }
}

function productionSpawn(request: PremierePreflightSpawnRequest): Promise<PremierePreflightProcessResult> {
  return new Promise((resolve, reject) => {
    const stdio: ["ignore", "pipe", "pipe", number?] = request.source_fd === null
      ? ["ignore", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe", request.source_fd];
    const child = spawn(request.executable, request.argv, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      stdio,
    });
    const childPid = child.pid;
    if (!positiveInteger(childPid)) {
      child.kill();
      reject(new Error("forbidden_process: spawned child has no PID"));
      return;
    }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) child.kill();
      else target.push(Buffer.from(chunk));
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (bytes > 16 * 1024 * 1024) {
        reject(new Error("forbidden_process: child output exceeded limit"));
        return;
      }
      resolve({
        exit_code: code ?? -1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        executable_realpath: request.executable,
        argv: [...request.argv],
        child_pid: childPid,
        parent_pid: request.parent_pid,
      });
    });
  });
}

export class PremierePreflightProcessBroker {
  readonly #cwd: string;
  readonly #runId: string;
  readonly #wrapperPid: number;
  readonly #env: Record<string, string>;
  readonly #spawn: PremierePreflightSpawn;
  readonly #realpath: (value: string) => string;
  readonly #executableIdentity: (value: string) => PremierePreflightExecutableIdentity;
  readonly #sourceFile: (value: string, fd: number) => boolean;
  readonly #platform: NodeJS.Platform;
  readonly #counts = new Set<string>();
  readonly #operationOrdinals = new Set<string>();
  readonly #receiptHashes = new Set<string>();
  readonly #discoveries = new Map<"ffmpeg" | "ffprobe", PremierePreflightToolDiscoveryReceipt>();
  #discoverySha: string | null = null;
  #nextDiscoveryOrdinal = 0;

  constructor(options: BrokerOptions) {
    if (Object.keys(options).some((key) => !["cwd", "preflight_run_id", "wrapper2_pid", "searchPath", "spawn", "realpath", "executableIdentity", "sourceFile", "platform"].includes(key))) forbidden("broker options fields are not closed");
    if (!path.isAbsolute(options.cwd) || !options.preflight_run_id || !positiveInteger(options.wrapper2_pid)) forbidden("broker configuration invalid");
    this.#cwd = options.cwd;
    this.#runId = options.preflight_run_id;
    this.#wrapperPid = options.wrapper2_pid;
    this.#env = { PATH: options.searchPath ?? DEFAULT_PATH, LANG: "C", LC_ALL: "C" };
    this.#spawn = options.spawn ?? productionSpawn;
    this.#realpath = options.realpath ?? fs.realpathSync;
    this.#executableIdentity = options.executableIdentity ?? defaultExecutableIdentity;
    this.#sourceFile = options.sourceFile ?? defaultSourceFile;
    this.#platform = options.platform ?? process.platform;
  }

  discoveryReceipt(tool: "ffmpeg" | "ffprobe"): PremierePreflightToolDiscoveryReceipt {
    const receipt = this.#discoveries.get(tool);
    if (!receipt) forbidden(`missing ${tool} discovery receipt`);
    return receipt;
  }

  async run(
    invocation: Extract<PremierePreflightInvocation, { kind: "which_ffmpeg" | "which_ffprobe" }>,
    binding: PremierePreflightDiscoveryBinding,
  ): Promise<PremierePreflightBrokerResult<PremierePreflightToolDiscoveryReceipt>>;
  async run(
    invocation: Exclude<PremierePreflightInvocation, { kind: "which_ffmpeg" | "which_ffprobe" }>,
    binding: PremierePreflightEvaluationBinding,
  ): Promise<PremierePreflightBrokerResult<PremierePreflightInvocationReceipt>>;
  async run(
    invocation: PremierePreflightInvocation,
    binding: PremierePreflightChildBinding,
  ): Promise<PremierePreflightBrokerResult<PremierePreflightToolDiscoveryReceipt | PremierePreflightInvocationReceipt>> {
    if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) forbidden("invocation invalid");
    if (invocation.kind === "which_ffmpeg" || invocation.kind === "which_ffprobe") {
      return this.#discover(invocation, binding as PremierePreflightDiscoveryBinding);
    }
    return this.#runEvaluation(invocation, binding as PremierePreflightEvaluationBinding);
  }

  async #discover(
    invocation: Extract<PremierePreflightInvocation, { kind: "which_ffmpeg" | "which_ffprobe" }>,
    binding: PremierePreflightDiscoveryBinding,
  ): Promise<PremierePreflightBrokerResult<PremierePreflightToolDiscoveryReceipt>> {
    exactKeys(invocation, ["kind"], "which invocation");
    this.#validateDiscoveryBinding(binding, invocation.kind === "which_ffmpeg" ? "ffmpeg" : "ffprobe");
    const executable = "/usr/bin/which", argv = [binding.tool];
    const result = await this.#spawnChecked(executable, argv, null);
    if (result.exit_code !== 0 || result.signal !== null || result.stderr !== "") forbidden("which discovery failed");
    const resolved = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
    if (!path.isAbsolute(resolved) || result.stdout !== resolved && result.stdout !== `${resolved}\n` || /[\r\n\0]/.test(resolved)) forbidden("which output is not one absolute path");
    const realpath = this.#realpath(resolved);
    if (!path.isAbsolute(realpath) || this.#realpath(realpath) !== realpath) forbidden("discovered executable path is not canonical");
    const identity = this.#executableIdentity(realpath);
    if (identity.realpath !== realpath) forbidden("discovered executable identity realpath mismatch");
    const body = {
      version: "premiere-effect-bake-tool-discovery-receipt/v1" as const,
      preflight_run_id: this.#runId,
      discovery_sha256: binding.discovery_sha256,
      tool: binding.tool,
      discovery_ordinal: binding.discovery_ordinal,
      executable_realpath: realpath,
      executable_identity: identity,
    };
    const receipt = deepFreeze({ ...body, broker_invocation_receipt_sha256: sha256(canonical(body)) }) as PremierePreflightToolDiscoveryReceipt;
    if (this.#receiptHashes.has(receipt.broker_invocation_receipt_sha256)) forbidden("discovery receipt hash reused");
    this.#receiptHashes.add(receipt.broker_invocation_receipt_sha256);
    this.#discoveries.set(binding.tool, receipt);
    this.#nextDiscoveryOrdinal += 1;
    return { stdout: result.stdout, stderr: result.stderr, receipt };
  }

  async #runEvaluation(
    invocation: Exclude<PremierePreflightInvocation, { kind: "which_ffmpeg" | "which_ffprobe" }>,
    binding: PremierePreflightEvaluationBinding,
  ): Promise<PremierePreflightBrokerResult<PremierePreflightInvocationReceipt>> {
    const cardinalityVariant = invocation.kind === "ready_cache_ffprobe"
      ? `${invocation.kind}:${invocation.probe_mode}`
      : invocation.kind;
    this.#validateEvaluationBinding(binding, invocation.kind, cardinalityVariant);
    const ffmpeg = this.discoveryReceipt("ffmpeg"), ffprobe = this.discoveryReceipt("ffprobe");
    let executable: string, argv: string[], sourceFd: number | null = null;
    switch (invocation.kind) {
      case "source_ffprobe":
        exactKeys(invocation, ["kind", "source_path", "source_fd"], "source ffprobe invocation");
        this.#validateLocalDescriptor(invocation.source_path, invocation.source_fd);
        executable = ffprobe.executable_realpath;
        sourceFd = invocation.source_fd;
        argv = ["-v", "error", "-show_format", "-show_streams", "-of", "json", "file:/dev/fd/3"];
        break;
      case "ready_cache_ffprobe":
        exactKeys(invocation, ["kind", "media_path", "media_fd", "probe_mode"], "READY ffprobe invocation");
        this.#validateLocalDescriptor(invocation.media_path, invocation.media_fd);
        executable = ffprobe.executable_realpath;
        sourceFd = invocation.media_fd;
        argv = invocation.probe_mode === "output_metadata"
          ? ["-v", "error", "-show_streams", "-show_format", "-of", "json", "file:/dev/fd/3"]
          : invocation.probe_mode === "packet_timing"
            ? ["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts,dts,duration", "-of", "json", "file:/dev/fd/3"]
            : invocation.probe_mode === "frame_timing"
              ? ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=pts,pkt_dts,duration,pkt_duration", "-of", "json", "file:/dev/fd/3"]
              : forbidden("READY ffprobe mode is not closed");
        break;
      case "ffmpeg_version":
        exactKeys(invocation, ["kind"], "ffmpeg version invocation");
        executable = ffmpeg.executable_realpath;
        argv = ["-version"];
        break;
      case "ready_cache_stream_hash":
        exactKeys(invocation, ["kind", "media_path", "media_fd"], "READY stream hash invocation");
        this.#validateLocalDescriptor(invocation.media_path, invocation.media_fd);
        executable = ffmpeg.executable_realpath;
        sourceFd = invocation.media_fd;
        argv = ["-v", "error", "-i", "file:/dev/fd/3", "-map", "0:v:0", "-c", "copy", "-f", "hash", "-hash", "sha256", "-"];
        break;
      case "sysctl_exact_if_reachable":
        exactKeys(invocation, ["kind"], "sysctl invocation");
        if (this.#platform !== "darwin") forbidden("sysctl callsite is unreachable on this platform");
        executable = "/usr/sbin/sysctl";
        argv = ["-n", "kern.boottime"];
        break;
      case "ps_exact_if_reachable":
        exactKeys(invocation, ["kind", "pid"], "ps invocation");
        if (!positiveInteger(invocation.pid)) forbidden("ps PID invalid");
        executable = this.#platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
        argv = ["-o", "lstart=", "-p", String(invocation.pid)];
        break;
      default:
        forbidden("invocation kind is not allowed");
    }
    const expectedIdentity = executable === ffmpeg.executable_realpath
      ? ffmpeg.executable_identity
      : executable === ffprobe.executable_realpath ? ffprobe.executable_identity : this.#executableIdentity(executable);
    if (!sameExecutableIdentity(this.#executableIdentity(executable), expectedIdentity)) forbidden("discovered executable identity changed before child execution");
    const result = await this.#spawnChecked(executable, argv, sourceFd);
    if (!sameExecutableIdentity(this.#executableIdentity(executable), expectedIdentity)) forbidden("discovered executable identity changed after child execution");
    const receiptBody = {
      variant: invocation.kind,
      binding: { ...binding },
      executable_realpath: executable,
      argv: [...argv],
      child_pid: result.child_pid,
      parent_pid: result.parent_pid,
      exit_code: result.exit_code,
      signal: result.signal,
      stdout_sha256: sha256(result.stdout),
      stderr_sha256: sha256(result.stderr),
    };
    const receipt = deepFreeze({ ...receiptBody, receipt_sha256: sha256(canonical(receiptBody)) }) as PremierePreflightInvocationReceipt;
    if (this.#receiptHashes.has(receipt.receipt_sha256)) forbidden("child receipt hash reused");
    this.#receiptHashes.add(receipt.receipt_sha256);
    return { stdout: result.stdout, stderr: result.stderr, receipt };
  }

  #validateDiscoveryBinding(binding: PremierePreflightDiscoveryBinding, tool: "ffmpeg" | "ffprobe"): void {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) forbidden("discovery binding invalid");
    exactKeys(binding, ["preflight_run_id", "wrapper2_pid", "discovery_sha256", "tool", "discovery_ordinal"], "discovery binding");
    const expectedOrdinal = tool === "ffmpeg" ? 0 : 1;
    if (binding.preflight_run_id !== this.#runId || binding.wrapper2_pid !== this.#wrapperPid || !SHA.test(binding.discovery_sha256)
      || binding.tool !== tool || binding.discovery_ordinal !== expectedOrdinal || binding.discovery_ordinal !== this.#nextDiscoveryOrdinal
      || this.#discoveries.has(tool) || this.#discoverySha !== null && this.#discoverySha !== binding.discovery_sha256) {
      forbidden("discovery binding values/cardinality invalid");
    }
    this.#discoverySha = binding.discovery_sha256;
  }

  #validateEvaluationBinding(
    binding: PremierePreflightEvaluationBinding,
    variant: PremierePreflightInvocationReceipt["variant"],
    cardinalityVariant: string,
  ): void {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) forbidden("evaluation binding invalid");
    exactKeys(binding, ["preflight_run_id", "wrapper2_pid", "evaluation_ordinal", "track_id", "clip_id", "evaluation_sha256", "request_sha256", "ready_cache_generation_id", "operation_ordinal"], "evaluation binding");
    const cacheVariant = variant === "ready_cache_ffprobe" || variant === "ready_cache_stream_hash";
    const finalAssociationVariant = cacheVariant || variant === "sysctl_exact_if_reachable" || variant === "ps_exact_if_reachable";
    if (binding.preflight_run_id !== this.#runId || binding.wrapper2_pid !== this.#wrapperPid
      || !Number.isSafeInteger(binding.evaluation_ordinal) || binding.evaluation_ordinal <= 0
      || typeof binding.track_id !== "string" || !binding.track_id || typeof binding.clip_id !== "string" || !binding.clip_id
      || !SHA.test(binding.evaluation_sha256)
      || binding.request_sha256 !== null && (!finalAssociationVariant || !SHA.test(binding.request_sha256))
      || cacheVariant !== (binding.ready_cache_generation_id !== null)
      || binding.ready_cache_generation_id !== null && !SHA.test(binding.ready_cache_generation_id)
      || !Number.isSafeInteger(binding.operation_ordinal) || binding.operation_ordinal < 0
      || this.#operationOrdinals.has(`${binding.evaluation_sha256}\0${binding.operation_ordinal}`)) forbidden("evaluation binding values invalid");
    if (this.#discoveries.size !== 2) forbidden("evaluation child requires both discovery receipts");
    this.#operationOrdinals.add(`${binding.evaluation_sha256}\0${binding.operation_ordinal}`);
    const countKey = `${cardinalityVariant}\0${binding.evaluation_sha256}\0${binding.ready_cache_generation_id ?? ""}`;
    if (this.#counts.has(countKey)) forbidden("process cardinality exceeded");
    this.#counts.add(countKey);
  }

  #validateLocalDescriptor(value: string, fd: number): void {
    if (!path.isAbsolute(value) || !SAFE_LOCAL_PATH.test(value) || value.includes("@")
      || /^(?:https?|tcp|udp|rtmp|srt):/i.test(value) || !positiveInteger(fd) || !this.#sourceFile(value, fd)) {
      forbidden("local input descriptor invalid");
    }
  }

  async #spawnChecked(executable: string, argv: string[], sourceFd: number | null): Promise<PremierePreflightProcessResult> {
    if (!path.isAbsolute(executable) || this.#realpath(executable) !== executable) forbidden("executable path is not canonical absolute");
    for (const arg of argv) {
      if (typeof arg !== "string" || /[\0\r\n]/.test(arg)) forbidden("argv contains control data");
      if (/^(?:https?|tcp|udp|rtmp|srt):/i.test(arg) || arg.startsWith("@")) forbidden("network or response-file argv rejected");
    }
    const request: PremierePreflightSpawnRequest = {
      executable,
      argv: [...argv],
      cwd: this.#cwd,
      env: { ...this.#env },
      source_fd: sourceFd,
      shell: false,
      parent_pid: this.#wrapperPid,
    };
    const result = await this.#spawn(request);
    this.#validateResult(result, request);
    return result;
  }

  #validateResult(result: PremierePreflightProcessResult, request: PremierePreflightSpawnRequest): void {
    if (!result || typeof result !== "object" || Array.isArray(result)) forbidden("process result invalid");
    exactKeys(result, ["exit_code", "signal", "stdout", "stderr", "executable_realpath", "argv", "child_pid", "parent_pid"], "process result");
    if (!Number.isInteger(result.exit_code) || result.signal !== null && typeof result.signal !== "string"
      || typeof result.stdout !== "string" || typeof result.stderr !== "string"
      || result.executable_realpath !== request.executable || canonical(result.argv) !== canonical(request.argv)
      || !positiveInteger(result.child_pid) || result.parent_pid !== this.#wrapperPid) forbidden("process result association invalid");
  }
}
