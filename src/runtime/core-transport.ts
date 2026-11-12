import net from "node:net";
import { randomUUID } from "node:crypto";
import { RuntimeError } from "./errors.js";

/** 一次請求一條連線；不重送，錯誤不包含 request params。 */
export class CoreTransport {
  constructor(
    readonly socketPath: string,
    readonly timeoutMs = 5000,
  ) {}
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = new net.Socket();
      let settled = false;
      let attempted = false;
      let buffer = "";
      const fail = (
        code: "RUNTIME_UNREACHABLE" | "RUNTIME_INCOMPATIBLE",
        reason: string,
      ) =>
        finish(
          new RuntimeError(code, {
            operation: method,
            reason,
            deliveryAttempted: attempted,
          }),
        );
      const timer = setTimeout(
        () => fail("RUNTIME_UNREACHABLE", "timeout"),
        timeoutMs,
      );
      const finish = (error?: RuntimeError, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 8 * 1024 * 1024)
          return fail("RUNTIME_INCOMPATIBLE", "response_too_large");
        let newline: number;
        while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let response: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              return fail("RUNTIME_INCOMPATIBLE", "invalid_response");
            response = parsed as Record<string, unknown>;
          } catch {
            return fail("RUNTIME_INCOMPATIBLE", "invalid_json");
          }
          if (response.jsonrpc !== "2.0")
            return fail("RUNTIME_INCOMPATIBLE", "invalid_jsonrpc");
          if (response.id !== id) continue;
          if (response.error !== undefined) {
            const error = response.error as {
              code?: unknown;
              data?: { kind?: unknown };
            };
            if (!error || typeof error.code !== "number")
              return fail("RUNTIME_INCOMPATIBLE", "invalid_error");
            return finish(
              new RuntimeError("RUNTIME_INCOMPATIBLE", {
                operation: method,
                rpcCode: error.code,
                rpcKind:
                  typeof error.data?.kind === "string"
                    ? error.data.kind
                    : undefined,
                reason: "rpc_error",
                deliveryAttempted: attempted,
              }),
            );
          }
          if (!("result" in response))
            return fail("RUNTIME_INCOMPATIBLE", "missing_result");
          finish(undefined, response.result as T);
        }
      });
      socket.once("error", () => fail("RUNTIME_UNREACHABLE", "socket_error"));
      socket.once("close", () => {
        if (!settled) fail("RUNTIME_UNREACHABLE", "closed");
      });
      socket.connect(this.socketPath, () => {
        attempted = true;
        socket.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    });
  }
}
