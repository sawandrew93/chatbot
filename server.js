require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Storage
const conversations = new Map();
const humanAgents = new Map(); // agentId -> {ws, user, status, sessionId}
const waitingQueue = [];
const agentSessions = new Map(); // agentId -> sessionId (for reconnection)
const customerTimeouts = new Map(); // sessionId -> timeout ID
const chatHistory = []; // Simple in-memory storage (use database in production)

// Agent users (in production, use a proper database)
const agentUsers = new Map([
  ['agent1', { 
    id: 'agent1', 
    username: 'john_doe', 
    email: 'john@company.com',
    name: 'John Doe',
    password: '$2b$10$example_hash_here', // bcrypt hash of 'password123'
    role: 'agent',
    isActive: true
  }],
  ['agent2', { 
    id: 'agent2', 
    username: 'jane_smith', 
    email: 'jane@company.com',
    name: 'Jane Smith',
    password: '$2b$10$example_hash_here2', // bcrypt hash of 'password456'
    role: 'senior_agent',
    isActive: true
  }]
]);

// Initialize with actual hashed passwords
async function initializeAgentUsers() {
  const users = [
    { id: 'agent1', username: 'john_doe', email: 'john@company.com', name: 'John Doe', password: 'password123', role: 'agent' },
    { id: 'agent2', username: 'jane_smith', email: 'jane@company.com', name: 'Jane Smith', password: 'password456', role: 'senior_agent' }
  ];

  for (const user of users) {
    const hashedPassword = await bcrypt.hash(user.password, 10);
    agentUsers.set(user.id, {
      ...user,
      password: hashedPassword,
      isActive: true
    });
  }
}

// Constants
const CUSTOMER_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const AGENT_RECONNECT_WINDOW = 30 * 1000; // 30 seconds
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-here';

// Knowledge Base
const knowledgeBase = [
  {
    topic: "product_features",
    content: "Our platform offers real-time analytics, automated reporting, and customizable dashboards."
  },
  {
    topic: "pricing",
    content: "We offer three tiers: Basic ($29/month), Professional ($79/month), and Enterprise ($199/month)."
  }
];

// ========== UTILITY FUNCTIONS ========== //
function searchKnowledgeBase(query) {
  const queryLower = query.toLowerCase();
  return knowledgeBase.filter(item => {
    const contentLower = item.content.toLowerCase();
    const topicLower = item.topic.toLowerCase();
    return contentLower.includes(queryLower) ||
           topicLower.includes(queryLower.replace(' ', '_'));
  });
}

// Customer timeout management
function setupCustomerTimeout(sessionId) {
  clearCustomerTimeout(sessionId);
  
  const timeoutId = setTimeout(() => {
    const conversation = conversations.get(sessionId);
    if (conversation && !conversation.hasHuman) {
      const index = waitingQueue.indexOf(sessionId);
      if (index > -1) {
        waitingQueue.splice(index, 1);
        
        // Notify all agents
        humanAgents.forEach((agentData, agentId) => {
          if (agentData.ws && agentData.ws.readyState === WebSocket.OPEN) {
            agentData.ws.send(JSON.stringify({
              type: 'customer_timeout',
              sessionId,
              remainingQueue: waitingQueue.length
            }));
          }
        });
        
        console.log(`Customer ${sessionId} timed out and removed from queue`);
      }
    }
    customerTimeouts.delete(sessionId);
  }, CUSTOMER_TIMEOUT);
  
  customerTimeouts.set(sessionId, timeoutId);
}

function clearCustomerTimeout(sessionId) {
  const timeoutId = customerTimeouts.get(sessionId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    customerTimeouts.delete(sessionId);
  }
}

// Chat history persistence
function saveChatHistory(sessionId, endReason = 'completed') {
  const conversation = conversations.get(sessionId);
  if (!conversation) return;
  
  const historyRecord = {
    sessionId,
    messages: [...conversation.messages],
    startTime: conversation.startTime || new Date(),
    endTime: new Date(),
    agentId: conversation.assignedAgent,
    agentName: conversation.agentName || 'Unknown',
    endReason,
    customerSatisfaction: null
  };
  
  chatHistory.push(historyRecord);
  console.log(`Chat history saved for session ${sessionId}`);
  return historyRecord;
}

// Agent reconnection helper
function handleAgentReconnection(agentId, ws, user) {
  const previousSessionId = agentSessions.get(agentId);
  if (previousSessionId) {
    const conversation = conversations.get(previousSessionId);
    if (conversation && conversation.hasHuman && conversation.assignedAgent === agentId) {
      // Restore the connection
      conversation.agentWs = ws;
      humanAgents.set(agentId, {
        ws,
        user,
        status: 'online',
        sessionId: previousSessionId
      });
      
      ws.send(JSON.stringify({
        type: 'connection_restored',
        sessionId: previousSessionId,
        message: 'Connection restored. You can continue the conversation.',
        history: conversation.messages.slice(-10)
      }));
      
      // Notify customer that agent is back
      if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
        conversation.customerWs.send(JSON.stringify({
          type: 'agent_reconnected',
          message: `${user.name} has reconnected and is back online.`
        }));
      }
      
      console.log(`Agent ${user.name} (${agentId}) reconnected to session ${previousSessionId}`);
      return true;
    }
  }
  return false;
}

// Send satisfaction survey
function sendSatisfactionSurvey(customerWs, sessionId) {
  if (customerWs && customerWs.readyState === WebSocket.OPEN) {
    customerWs.send(JSON.stringify({
      type: 'satisfaction_survey',
      sessionId,
      message: 'How was your experience with our support?',
      options: [
        { value: 5, label: '😊 Excellent' },
        { value: 4, label: '🙂 Good' },
        { value: 3, label: '😐 Okay' },
        { value: 2, label: '😕 Poor' },
        { value: 1, label: '😞 Very Poor' }
      ]
    }));
  }
}

// Check if user wants to speak to a human
function wantsHumanAgent(message) {
  const humanKeywords = [
    'human', 'agent', 'person', 'representative', 'speak to someone',
    'talk to human', 'customer service', 'support agent', 'live chat',
    'real person', 'not ai', 'not bot', 'transfer', 'escalate'
  ];
  
  const messageLower = message.toLowerCase();
  return humanKeywords.some(keyword => messageLower.includes(keyword));
}

async function generateAIResponse(userMessage) {
  if (wantsHumanAgent(userMessage)) {
    return null;
  }

  const relevantKnowledge = searchKnowledgeBase(userMessage);
  let context = "You are a helpful customer service AI assistant.\n";
  
  context += "If you cannot answer a question or if it requires complex assistance, suggest that the user can connect with a human agent by typing 'human' or clicking the person icon.\n";

  if (relevantKnowledge.length > 0) {
    context += "Relevant information:\n";
    relevantKnowledge.forEach(item => {
      context += `- ${item.content}\n`;
    });
  }

  try {
    const result = await model.generateContent(`${context}\nUser question: ${userMessage}`);
    return result.response.text();
  } catch (error) {
    console.error('AI generation error:', error);
    return "I'm having trouble processing your request right now. Would you like to connect with a human agent instead?";
  }
}

// ========== AUTHENTICATION ROUTES ========== //
app.post('/api/agent/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Find user by username
    let foundUser = null;
    for (const [id, user] of agentUsers) {
      if (user.username === username && user.isActive) {
        foundUser = { id, ...user };
        break;
      }
    }

    if (!foundUser) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, foundUser.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        agentId: foundUser.id,
        username: foundUser.username,
        role: foundUser.role
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Return user data (without password)
    const { password: _, ...userWithoutPassword } = foundUser;
    
    res.json({
      success: true,
      token,
      user: userWithoutPassword
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Middleware to verify JWT token
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ========== WEBSOCKET HANDLERS ========== //
async function handleCustomerMessage(ws, sessionId, message) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, {
      customerWs: ws,
      messages: [],
      hasHuman: false,
      agentWs: null,
      startTime: new Date()
    });
    setupCustomerTimeout(sessionId);
  }

  const conversation = conversations.get(sessionId);
  conversation.messages.push({ 
    role: 'user', 
    content: message, 
    timestamp: new Date() 
  });

  clearCustomerTimeout(sessionId);
  setupCustomerTimeout(sessionId);

  // If already connected to human agent, forward message
  if (conversation.hasHuman && conversation.agentWs) {
    if (conversation.agentWs.readyState === WebSocket.OPEN) {
      conversation.agentWs.send(JSON.stringify({
        type: 'customer_message',
        sessionId,
        message,
        timestamp: new Date()
      }));
    } else {
      // Agent connection lost, return to AI
      conversation.hasHuman = false;
      conversation.agentWs = null;
      const agentId = conversation.assignedAgent;
      if (agentId) {
        agentSessions.delete(agentId);
        humanAgents.delete(agentId);
      }
      conversation.assignedAgent = null;
      
      ws.send(JSON.stringify({
        type: 'agent_disconnected',
        message: 'Your agent has disconnected. I\'ll help you instead, or you can request another human agent.'
      }));
    }
    return;
  }

  try {
    const aiResponse = await generateAIResponse(message);
    
    if (aiResponse === null) {
      await handleHumanRequest(sessionId);
      return;
    }

    conversation.messages.push({ 
      role: 'assistant', 
      content: aiResponse, 
      timestamp: new Date() 
    });

    ws.send(JSON.stringify({
      type: 'ai_response',
      message: aiResponse,
      sessionId
    }));
  } catch (error) {
    console.error('AI error:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Sorry, I encountered an error. Would you like to connect with a human agent?'
    }));
  }
}

function handleAgentJoin(ws, data) {
  const { agentId, token } = data;
  
  // Verify JWT token
  let user;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    user = agentUsers.get(decoded.agentId);
    if (!user || !user.isActive) {
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid user account' }));
      ws.close();
      return;
    }
  } catch (error) {
    ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
    ws.close();
    return;
  }

  console.log(`Agent ${user.name} (${user.username}) connected`);
  
  // Check for reconnection first
  const wasReconnected = handleAgentReconnection(agentId, ws, user);
  
  if (!wasReconnected) {
    humanAgents.set(agentId, {
      ws,
      user,
      status: 'online',
      sessionId: null
    });
  }

  // Send current status
  ws.send(JSON.stringify({
    type: 'agent_status',
    message: wasReconnected ? `Welcome back, ${user.name}! Connection restored.` : `Welcome, ${user.name}! You're now online.`,
    waitingCustomers: waitingQueue.length,
    totalAgents: humanAgents.size,
    status: wasReconnected ? 'reconnected' : 'online',
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role
    }
  }));

  if (!wasReconnected) {
    // Notify agent of waiting customers
    waitingQueue.forEach((sessionId, index) => {
      const conversation = conversations.get(sessionId);
      if (conversation) {
        ws.send(JSON.stringify({
          type: 'pending_request',
          sessionId,
          position: index + 1,
          totalInQueue: waitingQueue.length,
          lastMessage: conversation.messages.slice(-1)[0]?.content || "New request"
        }));
      }
    });

    // Notify other agents about new agent joining
    humanAgents.forEach((agentData, otherId) => {
      if (otherId !== agentId && agentData.ws && agentData.ws.readyState === WebSocket.OPEN) {
        agentData.ws.send(JSON.stringify({
          type: 'agent_joined',
          agentId: agentId,
          agentName: user.name,
          totalAgents: humanAgents.size
        }));
      }
    });
  }
}

function handleAcceptRequest(sessionId, agentId) {
  const conversation = conversations.get(sessionId);
  const agentData = humanAgents.get(agentId);

  if (!conversation || !agentData) {
    console.log('Cannot accept request - conversation or agent not found');
    return;
  }

  if (conversation.hasHuman) {
    agentData.ws.send(JSON.stringify({
      type: 'request_already_taken',
      message: 'This customer has already been assigned to another agent',
      sessionId
    }));
    return;
  }

  conversation.hasHuman = true;
  conversation.agentWs = agentData.ws;
  conversation.assignedAgent = agentId;
  conversation.agentName = agentData.user.name;
  
  // Update agent data
  agentData.status = 'busy';
  agentData.sessionId = sessionId;
  agentSessions.set(agentId, sessionId);
  
  clearCustomerTimeout(sessionId);

  // Remove from queue
  const index = waitingQueue.indexOf(sessionId);
  if (index > -1) waitingQueue.splice(index, 1);

  // Notify other agents
  humanAgents.forEach((otherAgentData, otherId) => {
    if (otherId !== agentId && otherAgentData.ws && otherAgentData.ws.readyState === WebSocket.OPEN) {
      otherAgentData.ws.send(JSON.stringify({
        type: 'request_taken',
        sessionId,
        takenBy: agentData.user.name,
        remainingQueue: waitingQueue.length
      }));
    }
  });

  // Notify customer
  if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
    conversation.customerWs.send(JSON.stringify({
      type: 'human_joined',
      message: `${agentData.user.name} has joined the chat! How can I help you?`
    }));
  }

  // Send conversation history to agent
  agentData.ws.send(JSON.stringify({
    type: 'customer_assigned',
    sessionId,
    history: conversation.messages,
    queuePosition: 0,
    cannedResponses: [
      "Thank you for contacting us! How can I assist you today?",
      "I understand your concern. Let me look into this for you right away.",
      "Is there anything else I can help you with?",
      "Let me transfer you to a specialist who can better assist you.",
      "Thank you for your patience. I have the information you need.",
      "I apologize for any inconvenience. Let me resolve this for you.",
      "Your issue has been resolved. Is there anything else you need help with?"
    ]
  }));

  console.log(`Agent ${agentData.user.name} accepted request for session ${sessionId}. Queue now: ${waitingQueue.length}`);
}

function handleAgentMessage(sessionId, message, messageType = 'text') {
  const conversation = conversations.get(sessionId);
  if (!conversation || !conversation.customerWs) {
    console.log('Cannot send agent message - conversation or customer not found');
    return;
  }

  conversation.messages.push({ 
    role: 'agent', 
    content: message, 
    messageType,
    timestamp: new Date() 
  });
  
  if (conversation.customerWs.readyState === WebSocket.OPEN) {
    conversation.customerWs.send(JSON.stringify({
      type: 'agent_message',
      message,
      messageType,
      timestamp: new Date()
    }));
  }
}

function handleEndChat(sessionId) {
  const conversation = conversations.get(sessionId);
  if (!conversation) return;

  const agentId = conversation.assignedAgent;
  const agentData = humanAgents.get(agentId);

  saveChatHistory(sessionId, 'agent_ended');

  // Send satisfaction survey to customer
  if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
    sendSatisfactionSurvey(conversation.customerWs, sessionId);
    
    setTimeout(() => {
      if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
        conversation.customerWs.send(JSON.stringify({
          type: 'agent_left',
          message: 'The agent has ended the chat. Feel free to ask me anything else!'
        }));
      }
    }, 5000);
  }
  
  // Clean up conversation state
  conversation.hasHuman = false;
  conversation.agentWs = null;
  conversation.assignedAgent = null;
  conversation.agentName = null;
  
  // Update agent status
  if (agentId && agentData) {
    agentData.status = 'online';
    agentData.sessionId = null;
    agentSessions.delete(agentId);
  }
  
  // Notify other agents
  humanAgents.forEach((otherAgentData, otherId) => {
    if (otherId !== agentId && otherAgentData.ws && otherAgentData.ws.readyState === WebSocket.OPEN) {
      otherAgentData.ws.send(JSON.stringify({
        type: 'chat_ended',
        sessionId,
        endedBy: agentData ? agentData.user.name : 'Unknown',
        totalQueue: waitingQueue.length
      }));
    }
  });
  
  console.log(`Chat ended for session ${sessionId} by agent ${agentData ? agentData.user.name : 'Unknown'}`);
}

async function handleHumanRequest(sessionId) {
  const conversation = conversations.get(sessionId);
  if (!conversation) return;

  if (humanAgents.size === 0) {
    conversation.customerWs.send(JSON.stringify({
      type: 'no_agents_available',
      message: 'Sorry, no human agents are currently available. Please try again later or continue chatting with me!'
    }));
    return;
  }

  if (!waitingQueue.includes(sessionId)) {
    waitingQueue.push(sessionId);
  }

  const queuePosition = waitingQueue.indexOf(sessionId) + 1;

  // Notify all agents
  humanAgents.forEach((agentData, agentId) => {
    if (agentData.ws && agentData.ws.readyState === WebSocket.OPEN) {
      agentData.ws.send(JSON.stringify({
        type: 'pending_request',
        sessionId,
        position: queuePosition,
        totalInQueue: waitingQueue.length,
        lastMessage: conversation.messages.slice(-1)[0]?.content || "Customer wants to speak with human"
      }));
    }
  });

  if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
    conversation.customerWs.send(JSON.stringify({
      type: 'waiting_for_human',
      message: `You've been added to the queue (position ${queuePosition}). A human agent will be with you shortly.`
    }));
  }

  console.log(`Human request added to queue for session ${sessionId}, position ${queuePosition}`);
}

async function handleWebSocketMessage(ws, data) {
  try {
    console.log('Received message:', data.type);
    
    switch(data.type) {
      case 'customer_message':
        await handleCustomerMessage(ws, data.sessionId, data.message);
        break;
      case 'agent_join':
        handleAgentJoin(ws, data);
        break;
      case 'agent_message':
        handleAgentMessage(data.sessionId, data.message);
        break;
      case 'request_human':
        await handleHumanRequest(data.sessionId);
        break;
      case 'accept_request':
        handleAcceptRequest(data.sessionId, data.agentId);
        break;
      case 'end_chat':
        handleEndChat(data.sessionId);
        break;
      case 'satisfaction_response':
        // Handle satisfaction survey response
        const historyIndex = chatHistory.findIndex(h => h.sessionId === data.sessionId);
        if (historyIndex !== -1) {
          chatHistory[historyIndex].customerSatisfaction = {
            rating: data.rating,
            feedback: data.feedback,
            timestamp: new Date()
          };
          console.log(`Satisfaction response saved for session ${data.sessionId}: ${data.rating}/5`);
        }
        break;
      default:
        console.log('Unknown message type:', data.type);
    }
  } catch (error) {
    console.error('Message handling error:', error);
  }
}

// ========== WEBSOCKET SETUP ========== //
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      await handleWebSocketMessage(ws, data);
    } catch (error) {
      console.error('Message parse error:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    
    // Clean up disconnected agents
    for (const [agentId, agentData] of humanAgents) {
      if (agentData.ws === ws) {
        const sessionId = agentSessions.get(agentId);
        if (sessionId) {
          const conversation = conversations.get(sessionId);
          if (conversation && conversation.hasHuman) {
            console.log(`Agent ${agentData.user.name} disconnected from session ${sessionId}, waiting for reconnection...`);
            
            // Notify customer about temporary disconnection
            if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
              conversation.customerWs.send(JSON.stringify({
                type: 'agent_disconnected_temp',
                message: 'Your agent seems to have lost connection. They should be back shortly...'
              }));
            }
            
            // Set a timeout to end the chat if agent doesn't reconnect
            setTimeout(() => {
              const currentConversation = conversations.get(sessionId);
              if (currentConversation && currentConversation.assignedAgent === agentId && 
                  (!currentConversation.agentWs || currentConversation.agentWs.readyState !== WebSocket.OPEN)) {
                
                console.log(`Agent ${agentData.user.name} did not reconnect, ending chat ${sessionId}`);
                handleEndChat(sessionId);
              }
            }, AGENT_RECONNECT_WINDOW);
          }
        }
        
        humanAgents.delete(agentId);
        
        // Notify other agents
        humanAgents.forEach((otherAgentData, otherId) => {
          if (otherAgentData.ws && otherAgentData.ws.readyState === WebSocket.OPEN) {
            otherAgentData.ws.send(JSON.stringify({
              type: 'agent_left',
              agentId,
              agentName: agentData.user.name,
              totalAgents: humanAgents.size
            }));
          }
        });
        
        console.log(`Agent ${agentData.user.name} (${agentId}) disconnected`);
        break;
      }
    }

    // Clean up disconnected customers
    for (const [sessionId, conversation] of conversations) {
      if (conversation.customerWs === ws) {
        console.log(`Customer ${sessionId} disconnected`);
        
        clearCustomerTimeout(sessionId);
        
        // Remove from queue if waiting
        const queueIndex = waitingQueue.indexOf(sessionId);
        if (queueIndex > -1) {
          waitingQueue.splice(queueIndex, 1);
          
          // Notify agents of queue update
          humanAgents.forEach((agentData, agentId) => {
            if (agentData.ws && agentData.ws.readyState === WebSocket.OPEN) {
              agentData.ws.send(JSON.stringify({
                type: 'customer_left_queue',
                sessionId,
                remainingQueue: waitingQueue.length
              }));
            }
          });
        }
        
        // Save chat history if they were talking to an agent
        if (conversation.hasHuman) {
          saveChatHistory(sessionId, 'customer_disconnected');
        }
        
        break;
      }
    }
  });
});

// ========== ROUTES ========== //
app.get('/agent', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/agent.html'));
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    agents: humanAgents.size, 
    queue: waitingQueue.length,
    conversations: conversations.size,
    activeAgents: Array.from(humanAgents.values()).filter(agent => agent.status === 'online').length
  });
});

// Analytics endpoint
app.get('/analytics', verifyToken, (req, res) => {
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  
  const recentChats = chatHistory.filter(chat => chat.endTime >= last24h);
  const avgSatisfaction = recentChats
    .filter(chat => chat.customerSatisfaction?.rating)
    .reduce((sum, chat, _, arr) => sum + (chat.customerSatisfaction.rating / arr.length), 0);
  
  const avgChatDuration = recentChats.length > 0 
    ? recentChats.reduce((sum, chat, _, arr) => {
        const duration = chat.endTime - chat.startTime;
        return sum + (duration / arr.length);
      }, 0) / 1000 / 60
    : 0;

  res.json({
    totalChats: chatHistory.length,
    last24hChats: recentChats.length,
    averageSatisfaction: Math.round(avgSatisfaction * 100) / 100,
    averageChatDuration: Math.round(avgChatDuration * 100) / 100,
    currentQueue: waitingQueue.length,
    activeAgents: humanAgents.size,
    agentStatuses: Object.fromEntries([...humanAgents.entries()].map(([id, data]) => [id, {
      name: data.user.name,
      username: data.user.username,
      status: data.status,
      sessionId: data.sessionId
    }]))
  });
});

// Chat history endpoint
app.get('/chat-history', verifyToken, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const recentChats = chatHistory
    .slice(-limit)
    .map(chat => ({
      sessionId: chat.sessionId,
      startTime: chat.startTime,
      endTime: chat.endTime,
      agentId: chat.agentId,
      agentName: chat.agentName,
      messageCount: chat.messages.length,
      satisfaction: chat.customerSatisfaction?.rating || null,
      endReason: chat.endReason
    }));
  
  res.json(recentChats);
});

// Initialize and start server
async function startServer() {
  await initializeAgentUsers();
  
  server.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
    console.log('Available agent accounts:');
    for (const [id, user] of agentUsers) {
      console.log(`- ${user.name} (${user.username}) - Role: ${user.role}`);
    }
  });
}

startServer();
