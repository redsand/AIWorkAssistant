import localtunnel from "localtunnel";
import { spawn, ChildProcess } from "child_process";
import { env } from "../../config/env";

let tunnelUrl: string | null = null;
let tunnelInstance: localtunnel.Tunnel | null = null;
let cloudflaredProcess: ChildProcess | null = null;

export type TunnelProvider = "localtunnel" | "cloudflare";

async function startLocaltunnel(): Promise<string | null> {
  const options: localtunnel.TunnelConfig = {};
  if (env.TUNNEL_SUBDOMAIN) {
    options.subdomain = env.TUNNEL_SUBDOMAIN;
  }

  tunnelInstance = await localtunnel(env.PORT, options);
  tunnelUrl = tunnelInstance.url;

  tunnelInstance.on("close", () => {
    console.log("[Tunnel] Localtunnel connection closed");
    tunnelUrl = null;
  });

  tunnelInstance.on("error", (err: Error) => {
    console.error("[Tunnel] Localtunnel error:", err.message);
  });

  return tunnelUrl;
}

async function startCloudflared(): Promise<string | null> {
  const domain = env.TUNNEL_DOMAIN;
  const hostname = domain
    ? `${env.TUNNEL_SUBDOMAIN || "cal"}.${domain}`
    : undefined;

  const args = ["tunnel", "--url", `http://localhost:${env.PORT}`];
  if (hostname) {
    args.push("--hostname", hostname);
  }

  return new Promise((resolve, reject) => {
    cloudflaredProcess = spawn("cloudflared", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;

    cloudflaredProcess.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      const urlMatch = line.match(
        /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/,
      );
      if (urlMatch && !resolved) {
        resolved = true;
        tunnelUrl = urlMatch[0];
        resolve(tunnelUrl);
      }
    });

    cloudflaredProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      const urlMatch = line.match(
        /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/,
      );
      if (urlMatch && !resolved) {
        resolved = true;
        tunnelUrl = urlMatch[0];
        resolve(tunnelUrl);
      }
      if (!resolved) {
        console.log(`[Tunnel:cloudflared] ${line}`);
      }
    });

    cloudflaredProcess.on("error", (err: Error) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    cloudflaredProcess.on("exit", (code) => {
      console.log(`[Tunnel:cloudflared] Process exited with code ${code}`);
      tunnelUrl = null;
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Cloudflared tunnel startup timed out"));
      }
    }, 30000);
  });
}

export async function startTunnel(): Promise<string | null> {
  if (!env.TUNNEL_ENABLED) {
    console.log("[Tunnel] Disabled by TUNNEL_ENABLED env var");
    return null;
  }

  const provider: TunnelProvider = env.TUNNEL_PROVIDER;

  console.log(`[Tunnel] Starting ${provider} tunnel on port ${env.PORT}...`);

  try {
    if (provider === "cloudflare") {
      try {
        const url = await startCloudflared();
        if (url) {
          const domain = env.TUNNEL_DOMAIN;
          console.log(
            `[Tunnel:cloudflare] Public URL: ${url}${domain ? ` (domain: ${domain})` : ""}`,
          );
        }
        return url;
      } catch (cloudflaredErr) {
        console.warn(
          `[Tunnel:cloudflare] Failed: ${(cloudflaredErr as Error).message}`,
        );
        console.log("[Tunnel] Falling back to localtunnel...");
      }
    }

    const url = await startLocaltunnel();
    if (url) {
      console.log(`[Tunnel:localtunnel] Public URL: ${url}`);
    }
    return url;
  } catch (error) {
    console.error("[Tunnel] Failed to start:", (error as Error).message);
    return null;
  }
}

export function getTunnelUrl(): string | null {
  if (env.TUNNEL_URL) {
    return env.TUNNEL_URL;
  }
  return tunnelUrl;
}

export async function stopTunnel(): Promise<void> {
  if (tunnelInstance) {
    tunnelInstance.close();
    tunnelInstance = null;
  }
  if (cloudflaredProcess) {
    cloudflaredProcess.kill();
    cloudflaredProcess = null;
  }
  tunnelUrl = null;
}
