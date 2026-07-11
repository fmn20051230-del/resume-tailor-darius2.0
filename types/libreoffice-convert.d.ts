declare module "libreoffice-convert" {
  type ConvertCallback = (err: Error | null, data: Buffer) => void;

  function convert(
    document: Buffer,
    format: string,
    filter: string | undefined,
    callback: ConvertCallback
  ): void;

  const libre: { convert: typeof convert };
  export default libre;
}
