/**
 * ProjectSocketHub — WebSocket broadcast hub for project sync events.
 *
 * Manages per-project WebSocket rooms. Clients subscribe by connecting to
 * ws://host:port/api/ws?projectId=<id>.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server as HTTPServer } from "node:http";
import type { ProjectSyncEvent } from "./watch-hub.js";
import { safeProjectDir } from "../utils.js";

interface ClientInfo {
  ws: WebSocket;
  projectId: string;
}

export class ProjectSocketHub {
  private wss: WebSocketServer;
  private clients = new Set<ClientInfo>();
  private projectsDir: string;

  constructor(server: HTTPServer, projectsDir: string) {
    this.projectsDir = projectsDir;

    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade manually to validate project ID
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "", `http://${request.headers.host}`);

      if (url.pathname !== "/api/ws") {
        socket.destroy();
        return;
      }

      const projectId = url.searchParams.get("projectId");
      if (!projectId || !safeProjectDir(this.projectsDir, projectId)) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request, projectId);
      });
    });

    this.wss.on(
      "connection",
      (ws: WebSocket, _request: IncomingMessage, projectId: string) => {
        const client: ClientInfo = { ws, projectId };
        this.clients.add(client);

        ws.on("close", () => {
          this.clients.delete(client);
        });

        ws.on("error", () => {
          this.clients.delete(client);
        });

        // Send a welcome message so the client knows the connection is live
        ws.send(
          JSON.stringify({
            type: "connected",
            project_id: projectId,
            timestamp: new Date().toISOString(),
          }),
        );
      },
    );
  }

  /**
   * Broadcast a sync event to all clients subscribed to the event's project.
   */
  broadcast(event: ProjectSyncEvent): void {
    const payload = JSON.stringify(event);

    for (const client of this.clients) {
      if (
        client.projectId === event.project_id &&
        client.ws.readyState === WebSocket.OPEN
      ) {
        client.ws.send(payload);
      }
    }
  }

  /**
   * Get the set of project IDs with at least one connected client.
   */
  getActiveProjectIds(): Set<string> {
    const ids = new Set<string>();
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        ids.add(client.projectId);
      }
    }
    return ids;
  }

  /**
   * Shut down the WebSocket server.
   */
  destroy(): void {
    for (const client of this.clients) {
      client.ws.close();
    }
    this.clients.clear();
    this.wss.close();
  }
}
