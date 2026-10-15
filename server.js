// ============================================
// TELL — Backend Server
// Node.js + Express + Socket.io
// ============================================

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

// ---------- НАСТРОЙКИ ----------
const PORT = process.env.PORT || 3000;

// ---------- ХРАНИЛИЩЕ (пока в памяти) ----------
// Позже заменим на базу данных
const messages = {
    housing: [
        {
            id: 'seed_1',
            user: 'Александр',
            text: 'Сдам 1-комн. квартиру на Приморской, 2500₽/сут',
            time: Date.now() - 3600000,
            avatar: 'А'
        },
        {
            id: 'seed_2',
            user: 'Мария',
            text: 'Есть студия у моря, 3000₽/сут. Кто ищет?',
            time: Date.now() - 2400000,
            avatar: 'М'
        }
    ],
    work: [],
    market: [],
    trips: []
};

// ---------- EXPRESS ----------
const app = express();

app.use(cors()); // Разрешаем запросы с фронтенда
app.use(express.json({ limit: '10mb' })); // Поддержка JSON + картинок

// ---------- HTTP СЕРВЕР ----------
const server = http.createServer(app);

// ---------- SOCKET.IO ----------
const io = new Server(server, {
    cors: {
        origin: '*', // Пока разрешаем всем (позже ограничим доменами)
        methods: ['GET', 'POST']
    }
});

// ---------- API ЭНДПОИНТЫ ----------

// 1. Проверка, что сервер работает
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: '🚀 Tell Server работает',
        time: new Date().toISOString(),
        rooms: Object.keys(messages),
        totalMessages: Object.values(messages).reduce((sum, arr) => sum + arr.length, 0)
    });
});

// 2. Получить историю сообщений комнаты
app.get('/api/messages/:room', (req, res) => {
    const room = req.params.room;
    
    if (!messages[room]) {
        return res.status(404).json({ 
            error: 'Комната не найдена',
            available: Object.keys(messages)
        });
    }
    
    res.json({
        room: room,
        count: messages[room].length,
        messages: messages[room]
    });
});

// 3. Отправить сообщение (через HTTP, для теста)
app.post('/api/message', (req, res) => {
    const { room, user, text, avatar } = req.body;
    
    if (!room || !user || !text) {
        return res.status(400).json({ error: 'Нужны поля: room, user, text' });
    }
    
    if (!messages[room]) {
        messages[room] = [];
    }
    
    const message = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        user: user,
        text: text,
        avatar: avatar || user[0],
        time: Date.now()
    };
    
    messages[room].push(message);
    
    // Отправляем всем в комнате через Socket.io
    io.to(room).emit('new-message', message);
    
    res.json({ success: true, message: message });
});

// ---------- SOCKET.IO СОБЫТИЯ ----------
io.on('connection', (socket) => {
    console.log('🟢 Подключился клиент:', socket.id);
    
    // Клиент заходит в комнату
    socket.on('join-room', (room) => {
        socket.join(room);
        console.log(`👤 ${socket.id} вошёл в комнату: ${room}`);
        
        // Отправляем историю сообщений
        if (messages[room]) {
            socket.emit('room-history', messages[room]);
        }
    });
    
    // Клиент вышел из комнаты
    socket.on('leave-room', (room) => {
        socket.leave(room);
        console.log(`👋 ${socket.id} покинул комнату: ${room}`);
    });
    
    // Клиент отправил сообщение
    socket.on('send-message', (data) => {
        const { room, user, text, avatar } = data;
        
        if (!room || !user || !text) return;
        
        if (!messages[room]) {
            messages[room] = [];
        }
        
        const message = {
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            user: user,
            text: text,
            avatar: avatar || user[0],
            time: Date.now()
        };
        
        messages[room].push(message);
        
        // Отправляем всем в комнате, включая отправителя
        io.to(room).emit('new-message', message);
        
        console.log(`💬 [${room}] ${user}: ${text}`);
    });
    
    // Отключение
    socket.on('disconnect', () => {
        console.log('🔴 Отключился клиент:', socket.id);
    });
});

// ---------- ЗАПУСК ----------
server.listen(PORT, () => {
    console.log('');
    console.log('============================================');
    console.log('🚀 TELL SERVER ЗАПУЩЕН');
    console.log('============================================');
    console.log(`📍 Порт: ${PORT}`);
    console.log(`🌐 Локально: http://localhost:${PORT}`);
    console.log(`🌐 В сети: http://0.0.0.0:${PORT}`);
    console.log(`📦 Комнаты: ${Object.keys(messages).join(', ')}`);
    console.log('============================================');
    console.log('');
});