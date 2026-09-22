/**
 * 通用 TCP 连通探测 —— 数据源连通测试用（docs/API.md 1.1）。
 *
 * 用于尚未接入官方驱动的 oracle / postgresql 类型：验证 host:port 网络可达 + 握手前 RTT。
 * 账号密码校验需真实协议握手，第二阶段接入 oracledb / pg 驱动后替换。
 * memory 驱动模式下不使用本模块（保持 mock 演示规则）。
 */

const net = require('net');

/**
 * @param {Object} opts { host, port, timeoutMs }
 * @returns {Promise<{success:boolean,latencyMs:number,message:string}>}
 */
const probeTcp = ({ host, port, timeoutMs = 5000 }) =>
  new Promise((resolve) => {
    const target = `${host}:${port}`;
    if (!host || !port) {
      resolve({ success: false, latencyMs: 0, message: `参数不完整，无法探测: ${target}` });
      return;
    }
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finish({
        success: true,
        latencyMs: Date.now() - startedAt,
        message: `TCP 可达: ${target}（账号密码校验待第二阶段接入对应驱动）`,
      });
    });
    socket.once('timeout', () => finish({ success: false, latencyMs: Date.now() - startedAt, message: `连接超时(${timeoutMs}ms): ${target}` }));
    socket.once('error', (err) => finish({ success: false, latencyMs: Date.now() - startedAt, message: `连接失败(${err.code || err.message}): ${target}` }));
    socket.connect(Number(port), String(host));
  });

module.exports = { probeTcp };
