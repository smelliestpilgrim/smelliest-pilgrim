package com.smilingpilgrim.watchmemo.core;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Tiny HTTP/1.1 server on 127.0.0.1 only. One request per connection. */
public final class Http implements Runnable {
    private final MemoService service;
    private final int port;
    private volatile ServerSocket socket;
    private volatile boolean running;
    private Thread thread;

    public Http(MemoService service, int port) { this.service = service; this.port = port; }

    public synchronized void start() throws IOException {
        if (running) return;
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        // Explicit IPv4 loopback: getLoopbackAddress() can hand back ::1.
        s.bind(new InetSocketAddress(InetAddress.getByAddress(new byte[]{127, 0, 0, 1}), port), 16);
        socket = s;
        running = true;
        thread = new Thread(this, "watchmemo-http");
        thread.start();
    }

    public synchronized void stop() {
        running = false;
        try { if (socket != null) socket.close(); } catch (IOException ignored) {}
        socket = null;
    }

    public boolean isRunning() { return running; }

    @Override public void run() {
        while (running) {
            Socket c;
            try { c = socket.accept(); } catch (IOException e) { break; }
            final Socket conn = c;
            new Thread(() -> serve(conn), "watchmemo-conn").start();
        }
    }

    void serve(Socket c) {
        try (Socket s = c) {
            s.setSoTimeout(15000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            String line = readLine(in);
            if (line == null) return;
            String[] rl = line.split(" ");
            if (rl.length < 2) { respond(s, 400, "{\"ok\":false,\"error\":\"bad request\"}"); return; }
            int len = 0;
            String h;
            while ((h = readLine(in)) != null && !h.isEmpty()) {
                int k = h.indexOf(':');
                if (k > 0 && h.substring(0, k).trim().equalsIgnoreCase("content-length")) len = Integer.parseInt(h.substring(k + 1).trim());
            }
            if (len < 0 || len > Protocol.MAX_BODY) { respond(s, 413, "{\"ok\":false,\"error\":\"body too big\"}"); return; }
            byte[] body = new byte[len];
            int got = 0;
            while (got < len) { int r = in.read(body, got, len - got); if (r < 0) break; got += r; }
            if (got < len) { respond(s, 400, "{\"ok\":false,\"error\":\"short body\"}"); return; }
            String target = rl[1];
            int qm = target.indexOf('?');
            String path = qm >= 0 ? target.substring(0, qm) : target;
            Map<String, String> query = parseForm(qm >= 0 ? target.substring(qm + 1) : "");
            MemoService.Reply r = service.handle(rl[0], path, query, body);
            respond(s, r.status, r.json);
        } catch (Exception ignored) {}
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int b;
        while ((b = in.read()) >= 0) {
            if (b == '\n') break;
            if (b != '\r') sb.append((char) b);
            if (sb.length() > 8192) throw new IOException("line too long");
        }
        return b < 0 && sb.length() == 0 ? null : sb.toString();
    }

    private static void respond(Socket s, int status, String json) throws IOException {
        byte[] b = json.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + (status == 200 ? " OK" : " Error") + "\r\nContent-Type: application/json\r\nContent-Length: "
                + b.length + "\r\nConnection: close\r\n\r\n";
        OutputStream o = s.getOutputStream();
        o.write(head.getBytes(StandardCharsets.US_ASCII));
        o.write(b);
        o.flush();
    }

    public static Map<String, String> parseForm(String s) {
        Map<String, String> m = new HashMap<>();
        if (s == null || s.isEmpty()) return m;
        for (String kv : s.split("&")) {
            int k = kv.indexOf('=');
            try {
                if (k < 0) m.put(URLDecoder.decode(kv, "UTF-8"), "");
                else m.put(URLDecoder.decode(kv.substring(0, k), "UTF-8"), URLDecoder.decode(kv.substring(k + 1), "UTF-8"));
            } catch (Exception ignored) {}
        }
        return m;
    }

    public static String q(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            if (ch == '"' || ch == '\\') sb.append('\\').append(ch);
            else if (ch < 0x20) sb.append(String.format("\\u%04x", (int) ch));
            else sb.append(ch);
        }
        return sb.append('"').toString();
    }
}
