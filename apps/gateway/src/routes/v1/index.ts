import { Router, type IRouter } from "express";
import chatRouter from "./chat.js";
import modelsRouter from "./models.js";
import statusRouter from "./status.js";
import tokensRouter from "./tokens.js";

const v1Router: IRouter = Router();

v1Router.use("/chat", chatRouter);
v1Router.use("/models", modelsRouter);
v1Router.use("/status", statusRouter);
v1Router.use("/tokens", tokensRouter);

export default v1Router;
