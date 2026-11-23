#!/usr/bin/env python3
"""A web server that has moved its files, for the downloader test.

  redirect-server.py <port> <folder>

/new/<name>    the file <name> of the folder
/old/<name>    301 Moved Permanently to /new/<name>, with the small HTML page
               servers send along (what the stock downloader saved as the image)
/loop/<name>   redirects to itself, for ever
/away/<name>   redirects to a file:// address (must not be followed)
"""
import os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

port, folder = int(sys.argv[1]), sys.argv[2]
MOVED = (b'<html>\r\n<head><title>301 Moved Permanently</title></head>\r\n<body>\r\n'
         b'<center><h1>301 Moved Permanently</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def moved(self, where):
        self.send_response(301)
        self.send_header('Location', where)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(MOVED)))
        self.end_headers()
        self.wfile.write(MOVED)

    def do_GET(self):
        kind, _, name = self.path.lstrip('/').partition('/')
        path = os.path.join(folder, os.path.basename(name))
        if kind == 'old':
            self.moved(f'http://127.0.0.1:{port}/new/{name}')
        elif kind == 'loop':
            self.moved(f'http://127.0.0.1:{port}/loop/{name}')
        elif kind == 'away':
            self.moved('file://' + path)
        elif kind == 'new' and os.path.isfile(path):
            data = open(path, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_error(404)


HTTPServer(('127.0.0.1', port), Handler).serve_forever()
