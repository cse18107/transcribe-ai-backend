declare module 'express' {
  export interface Request {
    file?: any;
    body: any;
  }
  export interface Response {
    status(code: number): this;
    json(data: any): this;
  }
  export interface Application {
    use(middleware: any): this;
    listen(port: number, callback?: () => void): void;
    post(path: string, ...handlers: any[]): void;
  }
  export interface Express {
    json(): any;
    static(root: string): any;
  }
  const express: Express;
  export default express;
}

declare module 'cors';
declare module 'multer';
declare module 'fluent-ffmpeg';
declare module 'formdata-node'; 