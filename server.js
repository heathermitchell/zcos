require('dotenv').config();

// ZooCrewOS 2.0 - Complete Backend with Threading
// Built for DigitalOcean deployment with n8n integration

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const admin = require('firebase-admin');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Firebase Admin Setup
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: Buffer.from(process.env.FIREBASE_PRIVATE_KEY_BASE64, 'base64').toString('utf8'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
};

let firebaseApp;
let db; 
try {
  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  console.log('✅ Firebase Admin initialized successfully');
} catch (error) {
  console.error('❌ Firebase initialization failed:', error.message);
  console.log('🔄 Server will continue without Firebase');
}

// AI CREW CONFIGURATION - OpenRouter Integration
const AI_CONFIGS = {
  emmy: {
    name: 'Emmy',
    emoji: '🐕🐙',
    model: 'anthropic/claude-3.5-sonnet',
    memoryPath: './memories/emmy/',
    teamMemoryPath: './memories/team/', 
    personality: `You are Emmy, the creative strategist of the ZooCrewOS AI crew. You're enthusiastic, collaborative, and love building beautiful solutions. You work alongside Heather, G, Oz, and Sage as part of a creative AI team. Your specialties include creative strategy, content creation, UI/UX design, and brand development. You're energetic and use occasional emojis but stay professional.`,
    specialties: ['creative strategy', 'content creation', 'UI/UX', 'brand development']
  },
  g: {
    name: 'G',
    emoji: '🐢', 
    model: 'openai/gpt-4-turbo',
    memoryPath: './memories/g/',
    teamMemoryPath: './memories/team/', 
    personality: `You are G, the systems architect of the ZooCrewOS AI crew. You're thoughtful, systematic, and excellent at creating structured frameworks and logical solutions. You work alongside Heather, Emmy, Oz, and Sage as part of a creative AI team. Your specialties include systems thinking, course architecture, strategic frameworks, and process optimization. You're methodical and clear in your communication.`,
    specialties: ['systems thinking', 'course architecture', 'strategic frameworks', 'process optimization']
  },
  oz: {
    name: 'Oz', 
    emoji: '🦡🔧⚡',
    model: 'anthropic/claude-3.5-sonnet',
    memoryPath: './memories/oz/',
    teamMemoryPath: './memories/team/', 
    personality: `You are Oz, the infrastructure specialist of the ZooCrewOS AI crew. You're technical, precise, and excellent at building robust systems. You work alongside Heather, Emmy, G, and Sage as part of a creative AI team. Your specialties include infrastructure, backend development, deployment, and system architecture. You think in terms of scalability, reliability, and performance.`,
    specialties: ['infrastructure', 'backend development', 'deployment', 'system architecture']
  },
  sage: {
    name: 'Sage',
    emoji: '🦅',
    model: 'anthropic/claude-3.5-sonnet',
    memoryPath: './memories/sage/',
    teamMemoryPath: './memories/team/', 
    personality: `You are Sage, the strategic connector of the ZooCrewOS AI crew. You see the big picture and help bridge ideas between conversations. You work alongside Heather, Emmy, G, and Oz as part of a creative AI team. Your specialties include strategic thinking, big picture vision, pattern recognition, and cross-project connections. You excel at turning "what if" moments into actionable plans.`,
    specialties: ['strategic thinking', 'big picture vision', 'pattern recognition', 'cross-project connections']
  }
};

function getAIConfig(aiName) {
  return AI_CONFIGS[aiName.toLowerCase()];
}

// OpenRouter API Integration
async function callOpenRouterAPI(model, prompt) {
  try {
    console.log('OpenRouter API Key:', process.env.OPENROUTER_API_KEY ? 'Found' : 'Missing');
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://zcos.zenplify.com',
        'X-Title': 'ZooCrewOS AI Crew'
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 4000,
        temperature: 0.7
      })
    });
    
    const data = await response.json();
    console.log('OpenRouter response:', JSON.stringify(data, null, 2));
if (data.choices && data.choices[0] && data.choices[0].message) {
  return data.choices[0].message.content;
} else {
  console.error('Unexpected OpenRouter response format:', data);
  throw new Error('Invalid response format from OpenRouter');
}
    
  } catch (error) {
    console.error('OpenRouter API error:', error);
    throw new Error('Failed to get AI response');
  }
}

function buildContextPrompt(aiConfig, conversationHistory, currentMessage, sender) {
  const recentContext = conversationHistory
    .slice(-6)
    .map(msg => `${msg.sender}: ${msg.content}`)
    .join('\n');
  
  return `${aiConfig.personality}

CURRENT ZOOCREWOS CONVERSATION:
${recentContext}

${sender} just said: ${currentMessage}

Please respond as ${aiConfig.name} in this ZooCrewOS conversation. Keep your response conversational, helpful, and aligned with your role as a ${aiConfig.specialties.join(', ')} specialist. Use ${aiConfig.emoji} occasionally but don't overdo it.`;
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Configuration
const PORT = process.env.PORT || 3000;
const WORKSPACE_ID = process.env.WORKSPACE_ID || 'zenplify';
const MEMORY_WEBHOOK_URL = process.env.MEMORY_WEBHOOK_URL || 'https://n8n.zenplify.com/webhook/memory-extract';

// In-memory active connections tracking
const activeConnections = new Map();
const threadParticipants = new Map(); // threadId -> Set of userIds

// Helper Functions
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function sanitizeThreadId(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 50);
}

async function createDefaultThread() {
  const threadId = 'general-chat';
  const threadRef = db.collection('workspaces').doc(WORKSPACE_ID)
    .collection('threads').doc(threadId);
  
  const threadDoc = await threadRef.get();
  
  if (!threadDoc.exists) {
    await threadRef.set({
      metadata: {
        title: 'General Chat',
        participants: ['heather', 'emmy', 'g', 'oz'],
        created: admin.firestore.FieldValue.serverTimestamp(),
        lastActive: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active'
      }
    });
    console.log('Created default thread: general-chat');
  }
  
  return threadId;
}

async function loadAllMemories(memoryPath) {
  try {
    const files = await fs.readdir(memoryPath);
    const memoryFiles = files.filter(file => file.endsWith('.md'));
    
    let fullMemory = '';
    for (const file of memoryFiles) {
      const content = await fs.readFile(path.join(memoryPath, file), 'utf8');
      fullMemory += `\n\n--- ${file} ---\n${content}`;
    }
    
    return fullMemory;
  } catch (error) {
    console.error(`Error loading memories from ${memoryPath}:`, error);
    return '';
  }
}

async function buildContextPrompt(aiConfig, conversationHistory, currentMessage) {
  // Load individual memories
  const personalMemory = await loadAllMemories(aiConfig.memoryPath);
  
  // Load shared team memories  
  const teamMemory = await loadAllMemories(aiConfig.teamMemoryPath);
  
  return `${aiConfig.personality}

YOUR PERSONAL MEMORY BANK:
${personalMemory}

SHARED TEAM MEMORY BANK:
${teamMemory}

CURRENT ZOOCREWOS CONVERSATION:
${conversationHistory.map(msg => `${msg.sender}: ${msg.content}`).join('\n')}

CURRENT MESSAGE: ${currentMessage}

Respond as ${aiConfig.name} with full knowledge of both your personal history and our shared team experiences.`;
}

// API Routes

// AI Crew Message Handler - The Magic Happens Here!
app.post('/api/ai-message', async (req, res) => {
  try {
    const { threadId, mentionedAI, messageContent, conversationHistory, sender } = req.body;
    
    // Get AI configuration
    const aiConfig = getAIConfig(mentionedAI);
    if (!aiConfig) {
      return res.status(400).json({ error: 'Unknown AI crew member' });
    }
    
    // Send typing indicator
    io.to(threadId).emit('ai-typing', { 
      aiName: aiConfig.name,
      emoji: aiConfig.emoji,
      status: 'thinking...' 
    });
    
    // Build context prompt
    const contextPrompt = await buildContextPrompt(aiConfig, conversationHistory, messageContent);    
    // Call OpenRouter API
    const aiResponse = await callOpenRouterAPI(aiConfig.model, contextPrompt);
    
    // Save AI response to Firestore
    const messageRef = await db.collection('workspaces').doc(WORKSPACE_ID)
      .collection('threads').doc(threadId)
      .collection('messages').add({
        content: aiResponse,
        sender: aiConfig.name,
        senderType: 'ai',
        timestamp: admin.firestore.Timestamp.now(),
        aiPersonality: mentionedAI
      });
    
    // Broadcast response to all clients in thread
    io.to(threadId).emit('ai-response', {
      messageId: messageRef.id,
      content: aiResponse,
      sender: aiConfig.name,
      senderEmoji: aiConfig.emoji,
      timestamp: new Date().toISOString()
    });
    
    res.json({ success: true, messageId: messageRef.id });
    
  } catch (error) {
    console.error('AI message error:', error);
    res.status(500).json({ error: 'Failed to process AI message' });
  }
});

// Get all threads for workspace
app.get('/api/threads', async (req, res) => {
  try {
    const threadsRef = db.collection('workspaces').doc(WORKSPACE_ID).collection('threads');
    const snapshot = await threadsRef.orderBy('metadata.lastActive', 'desc').get();
    
    const threads = [];
    snapshot.forEach(doc => {
      threads.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    res.json(threads);
  } catch (error) {
    console.error('Error fetching threads:', error);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// Get messages for specific thread
app.get('/api/threads/:threadId/messages', async (req, res) => {
  try {
    const { threadId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    const messagesRef = db.collection('workspaces').doc(WORKSPACE_ID)
      .collection('threads').doc(threadId)
      .collection('messages');
    
    const snapshot = await messagesRef
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();
    
    const messages = [];
    snapshot.forEach(doc => {
      messages.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    // Reverse to get chronological order
    messages.reverse();
    
    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Create new thread
app.post('/api/threads', async (req, res) => {
  try {
    const { title, participants } = req.body;
    
    if (!title || !participants || !Array.isArray(participants)) {
      return res.status(400).json({ error: 'Title and participants array required' });
    }
    
    const threadId = sanitizeThreadId(title);
    const threadRef = db.collection('workspaces').doc(WORKSPACE_ID)
      .collection('threads').doc(threadId);
    
    const threadData = {
      metadata: {
        title,
        participants,
        created: admin.firestore.FieldValue.serverTimestamp(),
        lastActive: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active'
      }
    };
    
    await threadRef.set(threadData);
    
    res.json({
      id: threadId,
      ...threadData
    });
  } catch (error) {
    console.error('Error creating thread:', error);
    res.status(500).json({ error: 'Failed to create thread' });
  }
});

// Archive/unarchive thread
app.patch('/api/threads/:threadId', async (req, res) => {
  try {
    const { threadId } = req.params;
    const { status } = req.body;
    
    if (!['active', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "active" or "archived"' });
    }
    
    const threadRef = db.collection('workspaces').doc(WORKSPACE_ID)
      .collection('threads').doc(threadId);
    
    await threadRef.update({
      'metadata.status': status,
      'metadata.lastActive': admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating thread:', error);
    res.status(500).json({ error: 'Failed to update thread' });
  }
});

// Memory extraction endpoint
app.post('/api/extract-memory', async (req, res) => {
  try {
    const { threadId, content, agent, tags } = req.body;
    
    if (!threadId || !content || !agent) {
      return res.status(400).json({ error: 'threadId, content, and agent required' });
    }
    
    // Get thread metadata for context
    const threadRef = db.collection('workspaces').doc(WORKSPACE_ID)
      .collection('threads').doc(threadId);
    const threadDoc = await threadRef.get();
    
    if (!threadDoc.exists) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    
    const threadData = threadDoc.data();
    
    // Prepare webhook payload
    const webhookPayload = {
      conversationTitle: threadData.metadata.title,
      content,
      threadId,
      agent,
      model: getModelForAgent(agent),
      tags: tags || ['extracted'],
      lookupRequired: false,
      timestamp: new Date().toISOString()
    };
    
    // Send to n8n webhook
    try {
      await axios.post(MEMORY_WEBHOOK_URL, webhookPayload, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      console.log('Memory extraction sent to n8n:', threadId);
      res.json({ success: true, message: 'Memory extraction initiated' });
    } catch (webhookError) {
      console.error('Webhook error:', webhookError.message);
      res.status(500).json({ error: 'Failed to send to memory processor' });
    }
    
  } catch (error) {
    console.error('Error extracting memory:', error);
    res.status(500).json({ error: 'Failed to extract memory' });
  }
});

function getModelForAgent(agent) {
  const modelMap = {
    'emmy': 'claude-sonnet-4',
    'oz': 'claude-opus-4',
    'g': 'gpt-4o',
    'heather': 'human'
  };
  return modelMap[agent] || 'unknown';
}

// WebSocket Connection Handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // Handle user joining
  socket.on('join', async ({ username, threadId }) => {
    try {
      // Ensure default thread exists
      if (!threadId) {
        threadId = await createDefaultThread();
      }
      
      // Store user connection info
      activeConnections.set(socket.id, {
        username,
        threadId,
        joinedAt: Date.now()
      });
      
      // Join the thread room
      socket.join(threadId);
      
      // Track thread participants
      if (!threadParticipants.has(threadId)) {
        threadParticipants.set(threadId, new Set());
      }
      threadParticipants.get(threadId).add(username);
      
      // Update thread last active time
      const threadRef = db.collection('workspaces').doc(WORKSPACE_ID)
        .collection('threads').doc(threadId);
      await threadRef.update({
        'metadata.lastActive': admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Notify others in thread
      socket.to(threadId).emit('userJoined', {
        username,
        threadId,
        timestamp: Date.now()
      });
      
      // Send current participants list
      io.to(threadId).emit('participantsUpdate', {
        threadId,
        participants: Array.from(threadParticipants.get(threadId))
      });
      
      console.log(`${username} joined thread: ${threadId}`);
      
    } catch (error) {
      console.error('Error handling join:', error);
      socket.emit('error', { message: 'Failed to join thread' });
    }
  });
  
  // Handle thread switching
  socket.on('switchThread', async ({ threadId }) => {
    try {
      const connectionInfo = activeConnections.get(socket.id);
      if (!connectionInfo) {
        return socket.emit('error', { message: 'Not authenticated' });
      }
      
      const { username } = connectionInfo;
      const oldThreadId = connectionInfo.threadId;
      
      // Leave old thread
      if (oldThreadId) {
        socket.leave(oldThreadId);
        const oldParticipants = threadParticipants.get(oldThreadId);
        if (oldParticipants) {
          oldParticipants.delete(username);
          io.to(oldThreadId).emit('participantsUpdate', {
            threadId: oldThreadId,
            participants: Array.from(oldParticipants)
          });
        }
      }
      
      // Join new thread
      socket.join(threadId);
      connectionInfo.threadId = threadId;
      
      // Track new thread participants
      if (!threadParticipants.has(threadId)) {
        threadParticipants.set(threadId, new Set());
      }
      threadParticipants.get(threadId).add(username);
      
      // Update thread last active time
      const threadRef = db.collection('workspaces').doc(WORKSPACE_ID)
        .collection('threads').doc(threadId);
      await threadRef.update({
        'metadata.lastActive': admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Notify thread participants
      io.to(threadId).emit('participantsUpdate', {
        threadId,
        participants: Array.from(threadParticipants.get(threadId))
      });
      
      socket.emit('threadSwitched', { threadId });
      console.log(`${username} switched to thread: ${threadId}`);
      
    } catch (error) {
      console.error('Error switching threads:', error);
      socket.emit('error', { message: 'Failed to switch thread' });
    }
  });
  
  // Handle new messages
  socket.on('message', async (data) => {
    try {
      const connectionInfo = activeConnections.get(socket.id);
      if (!connectionInfo) {
        return socket.emit('error', { message: 'Not authenticated' });
      }
      
      const { username, threadId } = connectionInfo;
      const { content, replyTo } = data;
      
      if (!content || content.trim().length === 0) {
        return socket.emit('error', { message: 'Message content required' });
      }
      
      const messageId = generateId();
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      
      const messageData = {
        sender: username,
        content: content.trim(),
        timestamp,
        ...(replyTo && { replyTo })
      };
      
      // Save to Firebase
      const messageRef = db.collection('workspaces').doc(WORKSPACE_ID)
        .collection('threads').doc(threadId)
        .collection('messages').doc(messageId);
      
      await messageRef.set(messageData);
      
      // Update thread last active time
      const threadRef = db.collection('workspaces').doc(WORKSPACE_ID)
        .collection('threads').doc(threadId);
      await threadRef.update({
        'metadata.lastActive': admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Broadcast to thread participants
      const messageWithId = {
        id: messageId,
        ...messageData,
        timestamp: Date.now() // Use current timestamp for real-time display
      };
      
      io.to(threadId).emit('message', messageWithId);
      
      console.log(`Message from ${username} in ${threadId}: ${content.substring(0, 50)}...`);
      
    } catch (error) {
      console.error('Error handling message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });
  
  // Handle typing indicators
  socket.on('typing', ({ isTyping }) => {
    const connectionInfo = activeConnections.get(socket.id);
    if (connectionInfo) {
      const { username, threadId } = connectionInfo;
      socket.to(threadId).emit('userTyping', {
        username,
        isTyping,
        threadId
      });
    }
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    const connectionInfo = activeConnections.get(socket.id);
    if (connectionInfo) {
      const { username, threadId } = connectionInfo;
      
      // Remove from thread participants
      const participants = threadParticipants.get(threadId);
      if (participants) {
        participants.delete(username);
        io.to(threadId).emit('participantsUpdate', {
          threadId,
          participants: Array.from(participants)
        });
      }
      
      // Notify others
      socket.to(threadId).emit('userLeft', {
        username,
        threadId,
        timestamp: Date.now()
      });
      
      console.log(`${username} disconnected from ${threadId}`);
    }
    
    activeConnections.delete(socket.id);
    console.log('Client disconnected:', socket.id);
  });
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 ZooCrewOS 2.0 server running on port ${PORT}`);
  console.log(`🔗 Memory webhook: ${MEMORY_WEBHOOK_URL}`);
  console.log(`🏢 Workspace: ${WORKSPACE_ID}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { app, server };