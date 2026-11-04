// ============================================
// TELL — Backend Server (с сохранением в файл)
// Node.js + Express + Socket.io
// ============================================

const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

// ---------- НАСТРОЙКИ ----------
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

// ---------- ХРАНИЛИЩЕ ----------
let messages = {
    housing: [],
    work: [],
    market: [],
    trips: []
};

// ---------- ФАЙЛОВАЯ СИСТЕМА ----------

// Загружаем сообщения из файла при запуске
function loadMessages() {
    try {
        if (fs.existsSync(MESSAGES_FILE)) {
            const raw = fs.readFileSync(MESSAGES_FILE, 'utf-8');
            const data = JSON.parse(raw);
            
            // Проверяем структуру
            if (data && typeof data === 'object') {
                messages = { ...messages, ...data };
                const total = Object.values(messages).reduce((sum, arr) => sum + arr.length, 0);
                console.log(`📂 Загружено сообщений: ${total}`);
            }
        } else {
            // Создаём папку data, если нет
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            console.log('📂 Файл сообщений не найден, создаём новый');
            saveMessages();
        }
    } catch (err) {
        console.error('❌ Ошибка загрузки сообщений:', err.message);
    }
}

// Сохраняем сообщения в файл
function saveMessages() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2), 'utf-8');
    } catch (err) {
        console.error('❌ Ошибка сохранения:', err.message);
    }
}

// Отложенное сохранение (чтобы не писать на диск на каждое сообщение)
let saveTimeout = null;
function scheduleSaveMessages() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        saveMessages();
        saveTimeout = null;
    }, 1000); // Сохраняем через 1 секунду после последнего сообщения
}

// ---------- EXPRESS ----------
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------- HTTP СЕРВЕР ----------
const server = http.createServer(app);

// ---------- SOCKET.IO ----------
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// ---------- API ----------

// Проверка сервера
app.get('/', (req, res) => {
    const total = Object.values(messages).reduce((sum, arr) => sum + arr.length, 0);
    res.json({
        status: 'ok',
        message: '🚀 Tell Server работает',
        time: new Date().toISOString(),
        rooms: Object.keys(messages),
        totalMessages: total
    });
});

// История комнаты
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

// Очистить комнату (для тестов)
app.delete('/api/messages/:room', (req, res) => {
    const room = req.params.room;
    
    if (messages[room]) {
        messages[room] = [];
        scheduleSaveMessages();
        io.to(room).emit('room-cleared');
        res.json({ success: true, message: `Комната ${room} очищена` });
    } else {
        res.status(404).json({ error: 'Комната не найдена' });
    }
});

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {
    console.log('🟢 Подключился клиент:', socket.id);
    
    // Клиент вошёл в комнату
    socket.on('join-room', (room) => {
        socket.join(room);
        console.log(`👤 ${socket.id} вошёл в: ${room}`);
        
        if (messages[room]) {
            socket.emit('room-history', messages[room]);
        }
    });
    
    // Клиент вышел из комнаты
    socket.on('leave-room', (room) => {
        socket.leave(room);
        console.log(`👋 ${socket.id} покинул: ${room}`);
    });
    
    // Клиент отправил сообщение
    socket.on('send-message', (data) => {
        const { room, user, text, avatar, image } = data;
        
        if (!room || !user) return;
        if (!text && !image) return;
        
        if (!messages[room]) {
            messages[room] = [];
        }
        
        const message = {
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            user: user,
            text: text || '',
            avatar: avatar || user[0],
            image: image || null,
            time: Date.now()
        };
        
        messages[room].push(message);
        
        // Ограничение: храним последние 500 сообщений в комнате
        if (messages[room].length > 500) {
            messages[room] = messages[room].slice(-500);
        }
        
        // Сохраняем в файл (отложенно)
        scheduleSaveMessages();
        
        // Отправляем всем в комнате
        io.to(room).emit('new-message', message);
        
        const preview = text ? text.substring(0, 30) : '[картинка]';
        console.log(`💬 [${room}] ${user}: ${preview}`);
    });
    
    // Очистка комнаты (только из админки, не из UI)
    socket.on('clear-room', (room) => {
        if (messages[room]) {
            messages[room] = [];
            scheduleSaveMessages();
            io.to(room).emit('room-cleared');
        }
    });
    
    socket.on('disconnect', () => {
        console.log('🔴 Отключился клиент:', socket.id);
    });
});

// ---------- ЗАПУСК ----------
loadMessages();

server.listen(PORT, () => {
    console.log('');
    console.log('============================================');
    console.log('🚀 TELL SERVER ЗАПУЩЕН');
    console.log('============================================');
    console.log(`📍 Порт: ${PORT}`);
    console.log(`🌐 Локально: http://localhost:${PORT}`);
    console.log(`📦 Комнаты: ${Object.keys(messages).join(', ')}`);
    console.log(`💾 Файл: ${MESSAGES_FILE}`);
    console.log('============================================');
    console.log('');
});