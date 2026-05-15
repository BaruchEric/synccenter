import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

export function bearerAuth(token: string) {
  const expected = Buffer.from(token, "utf8");

  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const header = req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing Bearer token" });
      return;
    }
    const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.status(401).json({ error: "invalid token" });
      return;
    }
    next();
  };
}
