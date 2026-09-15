// Optional audit runner's read-only local database observer. This never sends
// app commands or changes the state that the native assertion is checking.
/* global http, STAGE, output */
var result = http.get('http://127.0.0.1:8781/' + STAGE);
if (result.status !== 200) throw new Error(result.body);
output.auditObservation = JSON.parse(result.body);
