// SSE (Server-Sent Events) 流式输出工具
function setupSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // 禁用 Nginx 缓冲
  });

  // 心跳，防止连接被超时断开
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  // 客户端断开时清理
  res.on('close', () => {
    clearInterval(heartbeat);
  });

  return {
    send(event, data) {
      if (typeof data !== 'string') data = JSON.stringify(data);
      res.write(`event: ${event}\ndata: ${data}\n\n`);
    },
    sendData(data) {
      // 默认 event 名 'message'
      res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    },
    end(data) {
      clearInterval(heartbeat);
      if (data) {
        res.write(`event: done\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
      } else {
        res.write('event: done\ndata: {}\n\n');
      }
      res.end();
    },
    error(msg) {
      clearInterval(heartbeat);
      res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
      res.end();
    },
  };
}

module.exports = { setupSSE };
