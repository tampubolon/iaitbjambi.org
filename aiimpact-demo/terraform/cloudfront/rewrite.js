// Viewer-request function. Two jobs, decided by hostname:
//
//   aimpact.<domain>          -> /app/...    the builder UI
//   <slug>.<domain>           -> /sites/<slug>/...   a participant's page
//
// Cache-behaviour selection happens against the ORIGINAL uri, before this
// runs, so rewriting here does not move the request to another behaviour.
// /api/* is matched as its own behaviour and never reaches this function.
//
// CloudFront Functions have no network access and a sub-millisecond budget.
// String handling only.
var APP_HOST = 'aimpact';
var RESERVED = ['www', 'api', 'mail', 'ftp', 'admin', 'cdn', 'smtp', 'imap'];

function handler(event) {
  var request = event.request;
  var host = request.headers.host.value.toLowerCase();
  var label = host.split('.')[0];
  var uri = request.uri;

  // Directory requests and extensionless paths get index.html.
  if (uri.endsWith('/')) {
    uri += 'index.html';
  } else if (uri.lastIndexOf('.') < uri.lastIndexOf('/')) {
    uri += '/index.html';
  }

  if (label === APP_HOST) {
    request.uri = '/app' + uri;
    return request;
  }

  if (RESERVED.indexOf(label) !== -1) {
    return {
      statusCode: 404,
      statusDescription: 'Not Found',
      headers: { 'content-type': { value: 'text/plain; charset=utf-8' } },
      body: 'Halaman tidak ditemukan.'
    };
  }

  request.uri = '/sites/' + label + uri;
  return request;
}
