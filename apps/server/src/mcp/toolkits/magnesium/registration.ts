// magnesium: Magnesium's profile tools join the MCP server every thread has (goal 34)
import { toolkitRegistration } from "../../McpHttpServer.ts";
import * as MagnesiumHandlers from "./handlers.ts";
import { MagnesiumToolkit } from "./tools.ts";

export const layer = toolkitRegistration(MagnesiumToolkit, MagnesiumHandlers.layer);
