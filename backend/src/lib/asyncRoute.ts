import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
) => Promise<unknown>;

/** Forward rejected async Express 4 handlers to the configured error middleware. */
export function asyncRoute(handler: AsyncRequestHandler): RequestHandler {
    return (req, res, next) => {
        void handler(req, res, next).catch(next);
    };
}
