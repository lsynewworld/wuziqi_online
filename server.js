const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // 在生产环境中应该设置具体的域名
    methods: ["GET", "POST"]
  }
});

// 游戏房间管理
const rooms = new Map();
const waitingUsers = new Set();

// 静态文件服务
app.use(express.static('public'));

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 获取服务器状态
app.get('/status', (req, res) => {
  const activeRooms = Array.from(rooms.values()).map(room => ({
    roomId: room.roomId,
    players: room.players.map(p => ({ id: p.id, name: p.name, symbol: p.symbol })),
    gameStarted: room.gameStarted,
    currentTurn: room.currentTurn,
    createdAt: room.createdAt
  }));

  res.json({
    onlineUsers: io.engine.clientsCount,
    waitingUsers: waitingUsers.size,
    activeRooms: activeRooms.length,
    rooms: activeRooms,
    serverTime: new Date().toISOString()
  });
});

// Socket.IO 事件处理
io.on('connection', (socket) => {
  console.log(`用户连接: ${socket.id}`);
  
  // 用户加入游戏
  socket.on('join_game', (data) => {
    const { username } = data;
    
    if (!username || username.trim() === '') {
      socket.emit('error', { message: '用户名不能为空' });
      return;
    }

    // 为用户创建玩家对象
    const player = {
      id: socket.id,
      name: username.trim(),
      symbol: null,
      socket: socket
    };

    // 将用户添加到等待列表
    waitingUsers.add(player);
    socket.data.player = player;

    console.log(`用户 ${username} (${socket.id}) 加入等待列表`);
    
    // 通知用户已加入等待列表
    socket.emit('waiting', {
      message: '正在等待其他玩家...',
      waitingCount: waitingUsers.size
    });

    // 广播等待列表更新
    io.emit('waiting_list_update', {
      waitingCount: waitingUsers.size
    });

    // 尝试匹配玩家
    tryMatchPlayers();
  });

  // 用户创建房间
  socket.on('create_room', (data) => {
    const { username } = data;
    
    if (!username || username.trim() === '') {
      socket.emit('error', { message: '用户名不能为空' });
      return;
    }

    const roomId = uuidv4().substring(0, 8);
    const player = {
      id: socket.id,
      name: username.trim(),
      symbol: 'X',
      socket: socket
    };

    const room = {
      roomId,
      players: [player],
      gameStarted: false,
      currentTurn: 'X',
      board: Array(15).fill().map(() => Array(15).fill(null)),
      createdAt: new Date(),
      moveHistory: []
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.player = player;
    socket.data.roomId = roomId;

    console.log(`用户 ${username} 创建了房间 ${roomId}`);
    
    socket.emit('room_created', {
      roomId,
      message: '房间创建成功，等待其他玩家加入...',
      playerSymbol: 'X'
    });
  });

  // 用户加入房间
  socket.on('join_room', (data) => {
    const { username, roomId } = data;
    
    if (!username || username.trim() === '') {
      socket.emit('error', { message: '用户名不能为空' });
      return;
    }

    if (!roomId || !rooms.has(roomId)) {
      socket.emit('error', { message: '房间不存在' });
      return;
    }

    const room = rooms.get(roomId);
    
    if (room.players.length >= 2) {
      socket.emit('error', { message: '房间已满' });
      return;
    }

    if (room.gameStarted) {
      socket.emit('error', { message: '游戏已开始' });
      return;
    }

    const player = {
      id: socket.id,
      name: username.trim(),
      symbol: 'O',
      socket: socket
    };

    room.players.push(player);
    socket.join(roomId);
    socket.data.player = player;
    socket.data.roomId = roomId;

    console.log(`用户 ${username} 加入了房间 ${roomId}`);
    
    // 通知房间内所有玩家
    io.to(roomId).emit('player_joined', {
      roomId,
      players: room.players.map(p => ({ id: p.id, name: p.name, symbol: p.symbol })),
      message: `${username} 加入了房间`
    });

    // 自动开始游戏
    startGame(roomId);
  });

  // 玩家下棋
  socket.on('make_move', (data) => {
    const { x, y } = data;
    const player = socket.data.player;
    const roomId = socket.data.roomId;

    if (!player || !roomId || !rooms.has(roomId)) {
      socket.emit('error', { message: '游戏会话无效' });
      return;
    }

    const room = rooms.get(roomId);

    if (!room.gameStarted) {
      socket.emit('error', { message: '游戏尚未开始' });
      return;
    }

    if (room.currentTurn !== player.symbol) {
      socket.emit('error', { message: '还没到你的回合' });
      return;
    }

    // 检查位置是否有效
    if (x < 0 || x >= 15 || y < 0 || y >= 15 || room.board[y][x] !== null) {
      socket.emit('error', { message: '无效的位置' });
      return;
    }

    // 记录移动
    room.board[y][x] = player.symbol;
    room.moveHistory.push({
      player: player.symbol,
      x,
      y,
      timestamp: new Date()
    });

    console.log(`玩家 ${player.name} (${player.symbol}) 在位置 (${x},${y}) 下棋`);

    // 检查是否获胜
    const winner = checkWinner(room.board, x, y, player.symbol);
    
    if (winner) {
      room.gameStarted = false;
      
      io.to(roomId).emit('game_over', {
        winner: player.symbol,
        winnerName: player.name,
        winningLine: winner,
        board: room.board,
        message: `${player.name} 获胜！`
      });

      console.log(`游戏结束，${player.name} 获胜！`);
      
      // 清理房间
      setTimeout(() => {
        cleanupRoom(roomId);
      }, 30000); // 30秒后清理房间
      
      return;
    }

    // 检查是否平局
    if (room.moveHistory.length >= 225) { // 15x15 = 225
      room.gameStarted = false;
      
      io.to(roomId).emit('game_over', {
        winner: null,
        board: room.board,
        message: '平局！'
      });

      console.log('游戏结束，平局！');
      
      // 清理房间
      setTimeout(() => {
        cleanupRoom(roomId);
      }, 30000); // 30秒后清理房间
      
      return;
    }

    // 切换回合
    room.currentTurn = room.currentTurn === 'X' ? 'O' : 'X';

    // 广播移动
    io.to(roomId).emit('move_made', {
      x,
      y,
      symbol: player.symbol,
      playerName: player.name,
      currentTurn: room.currentTurn,
      board: room.board
    });
  });

  // 玩家准备
  socket.on('ready', () => {
    const player = socket.data.player;
    const roomId = socket.data.roomId;

    if (!player || !roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    player.ready = true;

    console.log(`玩家 ${player.name} 已准备`);
    
    // 检查是否所有玩家都已准备
    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      startGame(roomId);
    } else {
      io.to(roomId).emit('player_ready', {
        playerId: player.id,
        playerName: player.name,
        message: `${player.name} 已准备`
      });
    }
  });

  // 聊天消息
  socket.on('chat_message', (data) => {
    const { message } = data;
    const player = socket.data.player;
    const roomId = socket.data.roomId;

    if (!player || !message.trim()) {
      return;
    }

    const chatData = {
      playerId: player.id,
      playerName: player.name,
      playerSymbol: player.symbol,
      message: message.trim(),
      timestamp: new Date().toISOString()
    };

    if (roomId && rooms.has(roomId)) {
      io.to(roomId).emit('chat_message', chatData);
    } else {
      // 全局聊天
      io.emit('global_chat_message', chatData);
    }
  });

  // 重新开始游戏
  socket.on('restart_game', () => {
    const player = socket.data.player;
    const roomId = socket.data.roomId;

    if (!player || !roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    
    // 重置游戏状态
    room.gameStarted = false;
    room.currentTurn = 'X';
    room.board = Array(15).fill().map(() => Array(15).fill(null));
    room.moveHistory = [];
    room.players.forEach(p => p.ready = false);

    io.to(roomId).emit('game_reset', {
      message: '游戏已重置，请准备...'
    });
  });

  // 离开房间
  socket.on('leave_room', () => {
    const player = socket.data.player;
    const roomId = socket.data.roomId;

    if (!player || !roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    
    // 从房间中移除玩家
    room.players = room.players.filter(p => p.id !== player.id);
    
    console.log(`玩家 ${player.name} 离开了房间 ${roomId}`);

    if (room.players.length === 0) {
      // 如果房间为空，删除房间
      cleanupRoom(roomId);
    } else {
      // 通知其他玩家
      io.to(roomId).emit('player_left', {
        playerId: player.id,
        playerName: player.name,
        message: `${player.name} 离开了房间`,
        remainingPlayers: room.players.map(p => ({ id: p.id, name: p.name, symbol: p.symbol }))
      });

      // 如果游戏正在进行，结束游戏
      if (room.gameStarted) {
        room.gameStarted = false;
        io.to(roomId).emit('game_over', {
          winner: room.players[0].symbol,
          winnerName: room.players[0].name,
          message: '对手离开，游戏结束！'
        });
      }
    }

    // 清理玩家数据
    socket.leave(roomId);
    delete socket.data.roomId;
    delete socket.data.player;
  });

  // 断开连接处理
  socket.on('disconnect', () => {
    const player = socket.data.player;
    const roomId = socket.data.roomId;

    console.log(`用户断开连接: ${socket.id}`);

    if (player) {
      // 从等待列表中移除
      waitingUsers.delete(player);
      
      // 广播等待列表更新
      if (waitingUsers.size > 0) {
        io.emit('waiting_list_update', {
          waitingCount: waitingUsers.size
        });
      }

      // 处理房间相关逻辑
      if (roomId && rooms.has(roomId)) {
        const room = rooms.get(roomId);
        
        // 从房间中移除玩家
        room.players = room.players.filter(p => p.id !== player.id);
        
        console.log(`玩家 ${player.name} 断开连接，离开了房间 ${roomId}`);

        if (room.players.length === 0) {
          // 如果房间为空，删除房间
          cleanupRoom(roomId);
        } else {
          // 通知其他玩家
          io.to(roomId).emit('player_disconnected', {
            playerId: player.id,
            playerName: player.name,
            message: `${player.name} 断开连接`,
            remainingPlayers: room.players.map(p => ({ id: p.id, name: p.name, symbol: p.symbol }))
          });

          // 如果游戏正在进行，结束游戏
          if (room.gameStarted) {
            room.gameStarted = false;
            io.to(roomId).emit('game_over', {
              winner: room.players[0].symbol,
              winnerName: room.players[0].name,
              message: '对手断开连接，游戏结束！'
            });
          }
        }
      }
    }

    // 清理socket数据
    delete socket.data.player;
    delete socket.data.roomId;
  });

  // 心跳检测
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: new Date().toISOString() });
  });
});

// 尝试匹配玩家
function tryMatchPlayers() {
  if (waitingUsers.size >= 2) {
    const players = Array.from(waitingUsers).slice(0, 2);
    const [player1, player2] = players;

    // 从等待列表中移除
    waitingUsers.delete(player1);
    waitingUsers.delete(player2);

    // 创建房间
    const roomId = uuidv4().substring(0, 8);
    player1.symbol = 'X';
    player2.symbol = 'O';

    const room = {
      roomId,
      players: [player1, player2],
      gameStarted: false,
      currentTurn: 'X',
      board: Array(15).fill().map(() => Array(15).fill(null)),
      createdAt: new Date(),
      moveHistory: []
    };

    rooms.set(roomId, room);

    // 将玩家加入房间
    player1.socket.join(roomId);
    player2.socket.join(roomId);
    player1.socket.data.roomId = roomId;
    player2.socket.data.roomId = roomId;

    console.log(`匹配成功: ${player1.name} vs ${player2.name} (房间 ${roomId})`);

    // 通知玩家
    io.to(roomId).emit('match_found', {
      roomId,
      players: [
        { id: player1.id, name: player1.name, symbol: 'X' },
        { id: player2.id, name: player2.name, symbol: 'O' }
      ],
      message: '匹配成功！游戏即将开始...'
    });

    // 自动开始游戏
    setTimeout(() => {
      startGame(roomId);
    }, 2000);

    // 广播等待列表更新
    io.emit('waiting_list_update', {
      waitingCount: waitingUsers.size
    });
  }
}

// 开始游戏
function startGame(roomId) {
  if (!rooms.has(roomId)) return;

  const room = rooms.get(roomId);
  room.gameStarted = true;
  room.currentTurn = 'X';

  console.log(`房间 ${roomId} 游戏开始: ${room.players[0].name} (X) vs ${room.players[1].name} (O)`);

  io.to(roomId).emit('game_started', {
    roomId,
    currentTurn: 'X',
    players: room.players.map(p => ({ id: p.id, name: p.name, symbol: p.symbol })),
    message: '游戏开始！X方先行'
  });
}

// 检查获胜
function checkWinner(board, x, y, symbol) {
  const directions = [
    [1, 0],   // 水平
    [0, 1],   // 垂直
    [1, 1],   // 对角线
    [1, -1]   // 反对角线
  ];

  for (const [dx, dy] of directions) {
    let count = 1;
    const line = [{ x, y }];

    // 正方向
    for (let i = 1; i < 5; i++) {
      const nx = x + dx * i;
      const ny = y + dy * i;
      if (nx >= 0 && nx < 15 && ny >= 0 && ny < 15 && board[ny][nx] === symbol) {
        count++;
        line.push({ x: nx, y: ny });
      } else {
        break;
      }
    }

    // 反方向
    for (let i = 1; i < 5; i++) {
      const nx = x - dx * i;
      const ny = y - dy * i;
      if (nx >= 0 && nx < 15 && ny >= 0 && ny < 15 && board[ny][nx] === symbol) {
        count++;
        line.unshift({ x: nx, y: ny });
      } else {
        break;
      }
    }

    if (count >= 5) {
      return line;
    }
  }

  return null;
}

// 清理房间
function cleanupRoom(roomId) {
  if (rooms.has(roomId)) {
    const room = rooms.get(roomId);
    console.log(`清理房间 ${roomId} (${room.players.map(p => p.name).join(', ')})`);
    
    // 通知所有玩家房间已关闭
    io.to(roomId).emit('room_closed', {
      roomId,
      message: '房间已关闭'
    });

    // 清理房间
    rooms.delete(roomId);
  }
}

// 定期清理空闲房间
setInterval(() => {
  const now = new Date();
  for (const [roomId, room] of rooms.entries()) {
    // 清理超过1小时未活动的房间
    if ((now - room.createdAt) > 60 * 60 * 1000) {
      cleanupRoom(roomId);
    }
  }
}, 10 * 60 * 1000); // 每10分钟检查一次

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`五子棋WebSocket服务器启动在端口 ${PORT}`);
  console.log(`健康检查: http://localhost:${PORT}/health`);
  console.log(`服务器状态: http://localhost:${PORT}/status`);
});

// 错误处理
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason);
});