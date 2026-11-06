// 测试夹具：worker 启动后立刻以退出码 7 崩溃（模拟 OOM 被杀 / 沙箱崩）。
// 用途：验证 unpack worker-client 在"worker 已退出"时**立即**让在途请求失败，
//   而不是白等到 120s 超时（那会被误报成"卡住"）。
process.exit(7);
