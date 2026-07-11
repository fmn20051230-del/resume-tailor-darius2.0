declare module "libreoffice-convert" {
  import type { Callback } from "node:util";

  function convert(
    document: Buffer,
    format: string,
    filter: string | undefined,
    callback: Callback<Buffer>
  ): void;

  export default { convert };
}
