require('dotenv').config()
const path = require('path')
const fs = require('fs')
const http = require('http')
const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const multer = require('multer')
const { v4: uuidv4 } = require('uuid')

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
const PORT = process.env.PORT || 3000

// Simple JSON file storage
const DATA_DIR = path.join(__dirname, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json')
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json')
const NOTIFS_FILE = path.join(DATA_DIR, 'notifications.json')

for (const file of [USERS_FILE, FRIENDS_FILE, MESSAGES_FILE, NOTIFS_FILE]) {
	const dir = path.dirname(file)
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify([]))
}

function readJSON(file) {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
}
function writeJSON(file, data) {
	fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

const app = express()
const server = http.createServer(app)
const io = require('socket.io')(server, {
	cors: { origin: '*', methods: ['GET','POST'] }
})

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(cookieParser())
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))
app.use(express.static(path.join(__dirname, 'public')))

// Multer for image uploads
const storage = multer.diskStorage({
	destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
	filename: (req, file, cb) => {
		const ext = path.extname(file.originalname)
		cb(null, `${uuidv4()}${ext}`)
	}
})
const upload = multer({ storage })

function authMiddleware(req, res, next) {
	const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies.token
	if (!token) return res.status(401).json({ error: 'Unauthorized' })
	try {
		const payload = jwt.verify(token, JWT_SECRET)
		req.user = payload
		next()
	} catch (e) {
		return res.status(401).json({ error: 'Invalid token' })
	}
}

// Auth routes
app.post('/api/register', async (req, res) => {
	const { email, password } = req.body
	if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
	const users = readJSON(USERS_FILE)
	if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
		return res.status(400).json({ error: 'Email already registered' })
	}
	const passwordHash = await bcrypt.hash(password, 10)
	const user = { id: uuidv4(), email, passwordHash, createdAt: Date.now() }
	users.push(user)
	writeJSON(USERS_FILE, users)
	const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' })
	res.json({ token, user: { id: user.id, email: user.email } })
})

app.post('/api/login', async (req, res) => {
	const { email, password } = req.body
	const users = readJSON(USERS_FILE)
	const user = users.find(u => u.email.toLowerCase() === email?.toLowerCase())
	if (!user) return res.status(400).json({ error: 'Invalid email or password' })
	const ok = await bcrypt.compare(password || '', user.passwordHash)
	if (!ok) return res.status(400).json({ error: 'Invalid email or password' })
	const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' })
	res.json({ token, user: { id: user.id, email: user.email } })
})

app.get('/api/me', authMiddleware, (req, res) => {
	res.json({ user: req.user })
})

// User search
app.get('/api/users/search', authMiddleware, (req, res) => {
	const q = (req.query.email || '').toLowerCase()
	if (!q) return res.status(400).json({ error: 'Email required' })
	const users = readJSON(USERS_FILE)
	const exact = users.find(u => u.email.toLowerCase() === q)
	const partial = users.find(u => u.email.toLowerCase().includes(q))
	const user = exact || partial
	if (!user) return res.status(404).json({ error: 'User not found' })
	return res.json({ user: { id: user.id, email: user.email } })
})

// Friends management
app.post('/api/friends/add', authMiddleware, (req, res) => {
	const { email } = req.body
	if (!email) return res.status(400).json({ error: 'Email required' })
	const users = readJSON(USERS_FILE)
	const friend = users.find(u => u.email.toLowerCase() === email.toLowerCase())
	if (!friend) return res.status(404).json({ error: 'User not found' })
	const friends = readJSON(FRIENDS_FILE)
	const exists = friends.find(f => f.userId === req.user.id && f.friendId === friend.id)
	if (exists) return res.json({ ok: true })
	friends.push({ id: uuidv4(), userId: req.user.id, friendId: friend.id, createdAt: Date.now() })
	friends.push({ id: uuidv4(), userId: friend.id, friendId: req.user.id, createdAt: Date.now() })
	writeJSON(FRIENDS_FILE, friends)
	res.json({ ok: true })
})

app.get('/api/friends', authMiddleware, (req, res) => {
	const friends = readJSON(FRIENDS_FILE)
	const users = readJSON(USERS_FILE)
	const myFriends = friends
		.filter(f => f.userId === req.user.id)
		.map(f => users.find(u => u.id === f.friendId))
		.filter(Boolean)
		.map(u => ({ id: u.id, email: u.email }))
	res.json({ friends: myFriends })
})

app.post('/api/friends/remove', authMiddleware, (req, res) => {
	const { friendId } = req.body
	let friends = readJSON(FRIENDS_FILE)
	friends = friends.filter(f => !( (f.userId === req.user.id && f.friendId === friendId) || (f.userId === friendId && f.friendId === req.user.id) ))
	writeJSON(FRIENDS_FILE, friends)
	res.json({ ok: true })
})

// Messaging
app.get('/api/messages/:peerId', authMiddleware, (req, res) => {
	const messages = readJSON(MESSAGES_FILE)
	const convo = messages.filter(m => (m.fromId === req.user.id && m.toId === req.params.peerId) || (m.fromId === req.params.peerId && m.toId === req.user.id))
	res.json({ messages: convo })
})

app.post('/api/messages/:peerId', authMiddleware, (req, res) => {
	const { text, imageUrl } = req.body
	if (!text && !imageUrl) return res.status(400).json({ error: 'Message content required' })
	const messages = readJSON(MESSAGES_FILE)
	const message = { id: uuidv4(), fromId: req.user.id, toId: req.params.peerId, text: text || '', imageUrl: imageUrl || '', createdAt: Date.now() }
	messages.push(message)
	writeJSON(MESSAGES_FILE, messages)
	// notify recipient
	io.to(getUserRoom(req.params.peerId)).emit('message', message)
	createNotification(req.params.peerId, { type: 'message', fromId: req.user.id, messageId: message.id, createdAt: Date.now() })
	res.json({ ok: true, message })
})

app.post('/api/upload', authMiddleware, upload.single('image'), (req, res) => {
	if (!req.file) return res.status(400).json({ error: 'No file' })
	res.json({ url: `/uploads/${req.file.filename}` })
})

// Notifications
function createNotification(userId, payload) {
	const notifs = readJSON(NOTIFS_FILE)
	notifs.push({ id: uuidv4(), userId, ...payload })
	writeJSON(NOTIFS_FILE, notifs)
}

app.get('/api/notifications', authMiddleware, (req, res) => {
	const notifs = readJSON(NOTIFS_FILE).filter(n => n.userId === req.user.id)
	res.json({ notifications: notifs })
})

// WebRTC signaling via Socket.IO
const userIdToSocketId = new Map()

function getUserRoom(userId) { return `user:${userId}` }

io.on('connection', (socket) => {
	socket.on('auth', ({ token }) => {
		try {
			const payload = jwt.verify(token, JWT_SECRET)
			socket.data.user = payload
			userIdToSocketId.set(payload.id, socket.id)
			socket.join(getUserRoom(payload.id))
			io.to(socket.id).emit('auth-ok')
		} catch (e) {
			io.to(socket.id).emit('auth-error')
		}
	})

	socket.on('call:offer', ({ toUserId, offer }) => {
		const from = socket.data.user
		if (!from) return
		io.to(getUserRoom(toUserId)).emit('call:offer', { fromUserId: from.id, offer })
		createNotification(toUserId, { type: 'call', fromId: from.id, createdAt: Date.now() })
	})

	socket.on('call:answer', ({ toUserId, answer }) => {
		const from = socket.data.user
		if (!from) return
		io.to(getUserRoom(toUserId)).emit('call:answer', { fromUserId: from.id, answer })
	})

	socket.on('call:ice-candidate', ({ toUserId, candidate }) => {
		const from = socket.data.user
		if (!from) return
		io.to(getUserRoom(toUserId)).emit('call:ice-candidate', { fromUserId: from.id, candidate })
	})

	socket.on('disconnect', () => {
		if (socket.data.user) {
			userIdToSocketId.delete(socket.data.user.id)
		}
	})
})

server.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`)
})