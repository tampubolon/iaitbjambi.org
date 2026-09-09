// Viewer-request function: maps the subdomain onto an S3 key prefix, so
// nasigorengbudi.iaitbjambi.org serves sites/nasigorengbudi/index.html.
//
// CloudFront Functions have no network access and a sub-millisecond budget.
// Keep this to string handling only.
function handler(event) {
  var request = event.request;
  var host = request.headers.host.value.toLowerCase();
  var slug = host.split('.')[0];

  // Reserved names never map to a participant page.
  var reserved = ['www', 'api', 'mail', 'ftp', 'admin', 'cdn'];
  if (reserved.indexOf(slug) !== -1) {
    return {
      statusCode: 404,
      statusDescription: 'Not Found',
      headers: { 'content-type': { value: 'text/plain; charset=utf-8' } },
      body: 'Halaman tidak ditemukan.'
    };
  }

  var uri = request.uri;
  if (uri.endsWith('/')) {
    uri += 'index.html';
  } else if (uri.lastIndexOf('.') < uri.lastIndexOf('/')) {
    uri += '/index.html';
  }

  request.uri = '/sites/' + slug + uri;
  return request;
}
