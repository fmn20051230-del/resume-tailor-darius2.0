/**
 * Runtime stub for Vercel — LibreOffice is not available in serverless.
 */
module.exports = {
  convert: (_document, _format, _filter, callback) => {
    callback(new Error("Cannot find package 'libreoffice-convert'"));
  },
  default: {
    convert: (_document, _format, _filter, callback) => {
      callback(new Error("Cannot find package 'libreoffice-convert'"));
    },
  },
};
