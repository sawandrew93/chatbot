(function() {
  'use strict';
  
  class ChatWidget {
    constructor(options = {}) {
      this.options = {
        serverUrl: options.serverUrl || 'ws://54.255.136.171:3000/',
        position: options.position || 'bottom-right',
        primaryColor: options.primaryColor || '#007bff',
        title: options.title || 'Chat Support',
        ...options
      };
      
      this.sessionId = this.generateSessionId();
      this.ws = null;
      this.isOpen = false;
      this.messages = [];
      
      this.init();
    }
    
    generateSessionId() {
      return 'session_' + Math.random().toString(36).substr(2, 9);
    }
    
    init() {
      this.createWidget();
      this.connectWebSocket();
    }
    
    createWidget() {
      // Create widget container
      this.widget = document.createElement('div');
      this.widget.id = 'chat-widget';
      this.widget.innerHTML = this.getWidgetHTML();
      document.body.appendChild(this.widget);
      
      // Add styles
      const style = document.createElement('style');
      style.textContent = this.getWidgetCSS();
      document.head.appendChild(style);
      
      // Add event listeners
      this.addEventListeners();
    }
    
    getWidgetHTML() {
      return `
        <div class="chat-widget-container ${this.options.position}">
          <div class="chat-toggle" id="chat-toggle">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          
          <div class="chat-window" id="chat-window" style="display: none;">
            <div class="chat-header">
              <span class="chat-title">${this.options.title}</span>
              <button class="chat-close" id="chat-close">×</button>
            </div>
            
            <div class="chat-messages" id="chat-messages">
              <div class="message bot-message">
                <div class="message-content">
                  Hello! I'm here to help you. Ask me anything about our products and services, or type "human" if you'd like to speak with a person.
                </div>
              </div>
            </div>
            
            <div class="chat-input-container">
              <input type="text" id="chat-input" placeholder="Type your message..." />
              <button id="chat-send">Send</button>
              <button id="request-human" title="Request human support">👤</button>
            </div>
          </div>
        </div>
      `;
    }
    
    getWidgetCSS() {
      return `
        .chat-widget-container {
          position: fixed;
          z-index: 10000;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        
        .chat-widget-container.bottom-right {
          bottom: 20px;
          right: 20px;
        }
        
        .chat-widget-container.bottom-left {
          bottom: 20px;
          left: 20px;
        }
        
        .chat-toggle {
          width: 60px;
          height: 60px;
          background: ${this.options.primaryColor};
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          transition: all 0.3s ease;
          color: white;
        }
        
        .chat-toggle:hover {
          transform: scale(1.1);
        }
        
        .chat-window {
          width: 350px;
          height: 500px;
          background: white;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.3);
          display: flex;
          flex-direction: column;
          position: absolute;
          bottom: 70px;
          right: 0;
        }
        
        .chat-header {
          background: ${this.options.primaryColor};
          color: white;
          padding: 16px;
          border-radius: 12px 12px 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .chat-title {
          font-weight: 600;
        }
        
        .chat-close {
          background: none;
          border: none;
          color: white;
          font-size: 24px;
          cursor: pointer;
          padding: 0;
          width: 30px;
          height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        
        .message {
          display: flex;
          margin-bottom: 8px;
        }
        
        .message-content {
          max-width: 80%;
          padding: 12px 16px;
          border-radius: 18px;
          word-wrap: break-word;
        }
        
        .bot-message .message-content,
        .agent-message .message-content {
          background: #f1f1f1;
          color: #333;
          margin-right: auto;
        }
        
        .user-message {
          justify-content: flex-end;
        }
        
        .user-message .message-content {
          background: ${this.options.primaryColor};
          color: white;
          margin-left: auto;
        }
        
        .chat-input-container {
          padding: 16px;
          border-top: 1px solid #eee;
          display: flex;
          gap: 8px;
        }
        
        #chat-input {
          flex: 1;
          padding: 12px;
          border: 1px solid #ddd;
          border-radius: 20px;
          outline: none;
          font-size: 14px;
        }
        
        #chat-send, #request-human {
          padding: 12px 16px;
          background: ${this.options.primaryColor};
          color: white;
          border: none;
          border-radius: 20px;
          cursor: pointer;
          font-size: 14px;
        }
        
        #request-human {
          padding: 12px;
        }
        
        .typing-indicator {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 12px 16px;
          background: #f1f1f1;
          border-radius: 18px;
          margin-right: auto;
          max-width: 80px;
        }
        
        .typing-dot {
          width: 8px;
          height: 8px;
          background: #999;
          border-radius: 50%;
          animation: typing 1.4s infinite ease-in-out;
        }
        
        .typing-dot:nth-child(1) { animation-delay: -0.32s; }
        .typing-dot:nth-child(2) { animation-delay: -0.16s; }
        
        @keyframes typing {
          0%, 80%, 100% { transform: scale(0); }
          40% { transform: scale(1); }
        }
        
        @media (max-width: 480px) {
          .chat-window {
            width: calc(100vw - 40px);
            height: calc(100vh - 100px);
            bottom: 70px;
            right: 20px;
          }
        }
      `;
    }
    
    addEventListeners() {
      const toggle = document.getElementById('chat-toggle');
      const close = document.getElementById('chat-close');
      const input = document.getElementById('chat-input');
      const send = document.getElementById('chat-send');
      const requestHuman = document.getElementById('request-human');
      
      toggle.addEventListener('click', () => this.toggleChat());
      close.addEventListener('click', () => this.closeChat());
      send.addEventListener('click', () => this.sendMessage());
      requestHuman.addEventListener('click', () => this.requestHuman());
      
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          this.sendMessage();
        }
      });
    }
    
    connectWebSocket() {
      const wsUrl = this.options.serverUrl.replace('http', 'ws');
      this.ws = new WebSocket(wsUrl);
      
      this.ws.onopen = () => {
        console.log('WebSocket connected');
      };
      
      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleServerMessage(data);
      };
      
      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        // Attempt to reconnect after 3 seconds
        setTimeout(() => this.connectWebSocket(), 3000);
      };
      
      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    }
    
    handleServerMessage(data) {
      const { type, message } = data;
      
      switch (type) {
        case 'ai_response':
          this.hideTypingIndicator();
          this.addMessage(message, 'bot');
          break;
          
        case 'agent_message':
          this.addMessage(message, 'agent');
          break;
          
        case 'human_joined':
          this.addMessage(message, 'system');
          break;
          
        case 'waiting_for_human':
          this.addMessage(message, 'system');
          break;
          
        case 'error':
          this.hideTypingIndicator();
          this.addMessage(message, 'error');
          break;
      }
    }
    
    toggleChat() {
      const window = document.getElementById('chat-window');
      this.isOpen = !this.isOpen;
      window.style.display = this.isOpen ? 'flex' : 'none';
    }
    
    closeChat() {
      const window = document.getElementById('chat-window');
      this.isOpen = false;
      window.style.display = 'none';
    }
    
    sendMessage() {
      const input = document.getElementById('chat-input');
      const message = input.value.trim();
      
      if (!message) return;
      
      this.addMessage(message, 'user');
      input.value = '';
      
      // Show typing indicator
      this.showTypingIndicator();
      
      // Send to server
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'customer_message',
          sessionId: this.sessionId,
          message: message
        }));
      }
    }
    
    requestHuman() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'request_human',
          sessionId: this.sessionId
        }));
      }
    }
    
    addMessage(message, sender) {
      const messagesContainer = document.getElementById('chat-messages');
      const messageDiv = document.createElement('div');
      messageDiv.className = `message ${sender}-message`;
      
      messageDiv.innerHTML = `
        <div class="message-content">${message}</div>
      `;
      
      messagesContainer.appendChild(messageDiv);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
    
    showTypingIndicator() {
      const messagesContainer = document.getElementById('chat-messages');
      const typingDiv = document.createElement('div');
      typingDiv.className = 'message bot-message';
      typingDiv.id = 'typing-indicator';
      
      typingDiv.innerHTML = `
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      `;
      
      messagesContainer.appendChild(typingDiv);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
    
    hideTypingIndicator() {
      const indicator = document.getElementById('typing-indicator');
      if (indicator) {
        indicator.remove();
      }
    }
  }
  
  // Auto-initialize if options are provided
  window.ChatWidget = ChatWidget;
  
  // Auto-start if config is available
  if (window.chatWidgetConfig) {
    new ChatWidget(window.chatWidgetConfig);
  }
})();
