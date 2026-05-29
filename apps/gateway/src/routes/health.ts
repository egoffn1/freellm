import { type IRouter, Router } from "express";

const healthRouter: IRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

export default healthRouter;
