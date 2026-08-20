export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const forbidden = (why: string) => new HttpError(403, why);
export const badRequest = (why: string) => new HttpError(400, why);
export const conflict = (why: string) => new HttpError(409, why);
