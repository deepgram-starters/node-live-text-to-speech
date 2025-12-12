/**
 * ============================================================================
 * LIVE TEXT-TO-SPEECH - FRONTEND APPLICATION
 * ============================================================================
 *
 * This vanilla JavaScript application provides a real-time TTS interface
 * using WebSockets to communicate with Deepgram's live TTS API.
 *
 * KEY FEATURES:
 * - WebSocket-based real-time audio generation
 * - Queue-based generation with latency tracking
 * - Audio collection (wait for all chunks) then playback
 * - Error handling with graceful UI feedback
 *
 * ARCHITECTURE:
 * 1. User enters text + selects model
 * 2. Click "Generate" → Open WebSocket → Send text
 * 3. Collect audio chunks as they arrive
 * 4. On "Flushed" → Combine chunks → Play audio
 * 5. Add to queue with latency metrics
 */

/**
 * WebSocket endpoint for live TTS
 * Uses wss:// in production, ws:// in development
 */
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_BASE_URL = `${WS_PROTOCOL}//${window.location.host}`;
const WS_ENDPOINT = '/live-tts/stream';

/**
 * Application state
 * This tracks everything happening in the app
 */
const state = {
  websocket: null,           // Active WebSocket connection
  isConnecting: false,       // Are we currently connecting?
  isGenerating: false,       // Are we currently generating audio?

  // Current generation tracking
  currentGeneration: {
    text: '',                // Text being converted
    model: '',               // Voice model being used
    audioChunks: [],         // Collected audio chunks (Blobs)
    startTime: null,         // When generation started (for latency)
    metadata: null,          // Metadata from Deepgram
  },

  // Queue of completed generations
  queue: [],                 // Array of { id, text, model, audioBlob, latency, status }
  nextId: 1,                 // Auto-incrementing ID for queue items
};

let textInput;
let modelSelect;
let generateBtn;
let statusContainer;
let statusIcon;
let statusMessage;
let queueCount;
let clearQueueBtn;
let emptyState;
let queueList;
let audioPlayer;

/**
 * Initialize the application when the DOM is ready
 * This is the entry point for our app
 */
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 Initializing Live TTS application...');

  // Cache DOM elements
  textInput = document.getElementById('textInput');
  modelSelect = document.getElementById('modelSelect');
  generateBtn = document.getElementById('generateBtn');
  statusContainer = document.getElementById('statusContainer');
  statusIcon = document.getElementById('statusIcon');
  statusMessage = document.getElementById('statusMessage');
  queueCount = document.getElementById('queueCount');
  clearQueueBtn = document.getElementById('clearQueueBtn');
  emptyState = document.getElementById('emptyState');
  queueList = document.getElementById('queueList');
  audioPlayer = document.getElementById('audioPlayer');

  // Set up event listeners
  generateBtn.addEventListener('click', handleGenerate);
  clearQueueBtn.addEventListener('click', handleClearQueue);

  // Initialize UI
  updateQueueDisplay();

  console.log('✅ Application initialized');
});

/**
 * Handle the "Generate Audio" button click
 * This is the main entry point for audio generation
 */
function handleGenerate() {
  const text = textInput.value.trim();
  const model = modelSelect.value;

  // Validation
  if (!text) {
    showStatus('error', 'Please enter some text to convert');
    return;
  }

  if (state.isGenerating) {
    showStatus('warning', 'Generation already in progress');
    return;
  }

  console.log('🎙️ Starting generation:', { text: text.substring(0, 50) + '...', model });

  // Reset current generation state
  state.currentGeneration = {
    text: text,
    model: model,
    audioChunks: [],
    startTime: Date.now(),
    metadata: null,
  };

  // Update UI
  state.isGenerating = true;
  generateBtn.disabled = true;
  generateBtn.innerHTML = '<i class="fas fa-spinner spinning"></i> Generating...';
  showStatus('info', 'Connecting to Deepgram...');

  // Start WebSocket connection
  connectWebSocket(text, model);
}

/**
 * Establish WebSocket connection and send text for generation
 *
 * @param {string} text - The text to convert to speech
 * @param {string} model - The voice model to use
 */
function connectWebSocket(text, model) {
  try {
    // Construct WebSocket URL with model parameter
    const wsUrl = `${WS_BASE_URL}${WS_ENDPOINT}?model=${encodeURIComponent(model)}`;
    console.log('🔌 Connecting to WebSocket:', wsUrl);

    state.isConnecting = true;
    state.websocket = new WebSocket(wsUrl);

    // Set binary type to handle audio chunks
    state.websocket.binaryType = 'arraybuffer';

    /**
     * WEBSOCKET EVENT: onopen
     * Fires when connection is successfully established
     */
    state.websocket.onopen = () => {
      console.log('✅ WebSocket connected');
      state.isConnecting = false;
      showStatus('info', 'Generating audio...');

      // Send the text to Deepgram for TTS conversion
      const message = {
        type: 'Speak',
        text: text
      };

      console.log('📤 Sending text to Deepgram...');
      state.websocket.send(JSON.stringify(message));
    };

    /**
     * WEBSOCKET EVENT: onmessage
     * Handles all incoming messages from the server
     * Can receive: JSON messages OR binary audio data
     */
    state.websocket.onmessage = (event) => {
      // Check if this is binary audio data or JSON message
      if (event.data instanceof ArrayBuffer) {
        // This is an audio chunk!
        handleAudioChunk(event.data);
      } else {
        // This is a JSON message (Metadata, Flushed, Error, etc.)
        try {
          const message = JSON.parse(event.data);
          handleJsonMessage(message);
        } catch (error) {
          console.error('❌ Failed to parse message:', error);
        }
      }
    };

    /**
     * WEBSOCKET EVENT: onclose
     * Fires when the WebSocket connection closes
     */
    state.websocket.onclose = (event) => {
      console.log('🔌 WebSocket closed:', event.code, event.reason);
      state.isConnecting = false;
      state.isGenerating = false;

      // Handle different close codes per our error handling pattern
      if (event.code === 1011) {
        // Server error - error message was already shown
        // Don't overwrite it with a generic message
      } else if (event.code === 1000) {
        console.log('✅ Normal closure');
      } else {
        showStatus('warning', `Connection closed unexpectedly (code: ${event.code})`);
      }

      resetUI();
    };

    /**
     * WEBSOCKET EVENT: onerror
     * Fires when there's a WebSocket error
     */
    state.websocket.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
      showStatus('error', 'Connection error occurred');
      state.isConnecting = false;
      state.isGenerating = false;
      resetUI();
    };

  } catch (error) {
    console.error('❌ Failed to create WebSocket:', error);
    showStatus('error', 'Failed to connect: ' + error.message);
    state.isGenerating = false;
    resetUI();
  }
}

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

/**
 * Handle JSON messages from the server
 * These include: Open, Metadata, Flushed, Close, Error
 *
 * @param {Object} message - Parsed JSON message
 */
function handleJsonMessage(message) {
  console.log('📨 Received message:', message.type);

  switch (message.type) {
    case 'Open':
      console.log('✅ Connection opened');
      break;

    case 'Metadata':
      handleMetadata(message);
      break;

    case 'Flushed':
      handleFlushed();
      break;

    case 'Close':
      console.log('👋 Server closed connection');
      if (state.websocket) {
        state.websocket.close(1000, 'Server closed');
      }
      break;

    case 'Error':
      handleError(message.error);
      break;

    default:
      console.warn('⚠️ Unknown message type:', message.type);
  }
}

/**
 * Handle Metadata message from Deepgram
 * Contains information about the TTS request and model
 *
 * @param {Object} metadata - Metadata object from Deepgram
 */
function handleMetadata(metadata) {
  console.log('📋 Metadata received:', metadata);

  /**
   * TODO:USER - Store the metadata in state
   *
   * LEARNING OBJECTIVE: Understand what metadata Deepgram provides
   *
   * HINT: The metadata contains useful information like:
   * - request_id: Unique ID for this generation
   * - model_name: Which model is being used
   * - model_version: Version of the model
   * - model_uuid: Unique identifier for the model
   *
   * You should store this in: state.currentGeneration.metadata
   *
   * Example:
   * state.currentGeneration.metadata = {
   *   request_id: metadata.request_id,
   *   model_name: metadata.model_name,
   *   // ... add the rest
   * };
   */

  // TODO:USER - Store metadata here
  state.currentGeneration.metadata = metadata;
}

/**
 * Handle incoming audio chunk (binary data)
 * Collect chunks to play later when all chunks arrive
 *
 * @param {ArrayBuffer} arrayBuffer - Binary audio data
 */
function handleAudioChunk(arrayBuffer) {
  const chunkSize = arrayBuffer.byteLength;
  console.log(`🔊 Received audio chunk: ${chunkSize} bytes`);

  /**
   * TODO:USER - Convert ArrayBuffer to Blob and store it
   *
   * LEARNING OBJECTIVE: Understand binary data handling in JavaScript
   *
   * HINT: Audio data comes as ArrayBuffer, but we want to store it as Blob
   * Blobs are easier to work with for audio playback
   *
   * Steps:
   * 1. Convert ArrayBuffer to Blob with type 'audio/wav'
   * 2. Push the Blob to state.currentGeneration.audioChunks array
   *
   * Example:
   * const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
   * state.currentGeneration.audioChunks.push(blob);
   */

  // TODO:USER - Convert and store audio chunk
  const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
  state.currentGeneration.audioChunks.push(blob);

  // Update status with chunk count
  const chunkCount = state.currentGeneration.audioChunks.length;
  showStatus('info', `Receiving audio... (${chunkCount} chunk${chunkCount > 1 ? 's' : ''})`);
}

/**
 * Handle Flushed message from Deepgram
 * This means all audio chunks have been sent - time to play!
 */
function handleFlushed() {
  console.log('✅ All audio chunks received (Flushed)');

  // Calculate latency
  const latency = Date.now() - state.currentGeneration.startTime;
  console.log(`⏱️ Generation latency: ${latency}ms`);

  // Combine all audio chunks into a single Blob
  const completeAudioBlob = new Blob(state.currentGeneration.audioChunks, { type: 'audio/wav' });
  console.log(`🎵 Complete audio size: ${completeAudioBlob.size} bytes`);

  // Add to queue
  const queueItem = {
    id: state.nextId++,
    text: state.currentGeneration.text,
    model: state.currentGeneration.model,
    audioBlob: completeAudioBlob,
    latency: latency,
    status: 'complete',
    metadata: state.currentGeneration.metadata,
  };

  state.queue.unshift(queueItem); // Add to front of queue

  // Update UI
  showStatus('success', `Audio generated in ${latency}ms`);
  updateQueueDisplay();

  // Play the audio automatically
  playAudio(queueItem.id);

  // Close WebSocket
  if (state.websocket) {
    state.websocket.close(1000, 'Generation complete');
    state.websocket = null;
  }

  // Reset for next generation
  state.isGenerating = false;
  resetUI();

  // Clear text input for next entry
  textInput.value = '';
}

/**
 * Handle Error message from server
 * Display error clearly to the user
 *
 * @param {Object} error - Error object with type, code, message
 */
function handleError(error) {
  console.error('❌ Error from server:', error);

  const errorMessage = error.message || 'An unknown error occurred';
  showStatus('error', `Error: ${errorMessage}`);

  // Clean up
  if (state.websocket) {
    state.websocket.close(1000, 'Client closing due to error');
    state.websocket = null;
  }

  state.isGenerating = false;
  resetUI();
}

// ============================================================================
// AUDIO PLAYBACK
// ============================================================================

/**
 * Play audio for a specific queue item
 *
 * @param {number} itemId - ID of the queue item to play
 */
function playAudio(itemId) {
  const item = state.queue.find(q => q.id === itemId);

  if (!item || !item.audioBlob) {
    console.error('❌ No audio blob found for item:', itemId);
    return;
  }

  console.log(`🔊 Playing audio for item ${itemId}`);

  /**
   * TODO:USER - Implement audio playback
   *
   * LEARNING OBJECTIVE: Understand how to play audio from a Blob
   *
   * HINT: Steps to play audio:
   * 1. Create an object URL from the Blob using URL.createObjectURL()
   * 2. Set audioPlayer.src to this URL
   * 3. Call audioPlayer.play()
   * 4. (Optional) Clean up the object URL when done
   *
   * Example:
   * const audioUrl = URL.createObjectURL(item.audioBlob);
   * audioPlayer.src = audioUrl;
   * audioPlayer.play();
   *
   * audioPlayer.onended = () => {
   *   URL.revokeObjectURL(audioUrl); // Clean up
   * };
   */

  // TODO:USER - Implement playback here
  const audioUrl = URL.createObjectURL(item.audioBlob);
  audioPlayer.src = audioUrl;
  audioPlayer.play();

  audioPlayer.onended = () => {
    URL.revokeObjectURL(audioUrl);
    console.log('✅ Playback complete');
  };
}

// ============================================================================
// QUEUE MANAGEMENT
// ============================================================================

/**
 * Update the queue display in the UI
 * Shows all generated audio items with their metadata
 */
function updateQueueDisplay() {
  // Update counter
  queueCount.textContent = state.queue.length;

  // Show/hide empty state and clear button
  if (state.queue.length === 0) {
    emptyState.classList.remove('hidden');
    queueList.classList.add('hidden');
    clearQueueBtn.classList.add('hidden');
  } else {
    emptyState.classList.add('hidden');
    queueList.classList.remove('hidden');
    clearQueueBtn.classList.remove('hidden');
  }

  // Render queue items
  queueList.innerHTML = state.queue.map(item => `
    <div class="queue-item queue-item--${item.status}" data-id="${item.id}">
      <div class="queue-item__header">
        <div class="queue-item__text">"${escapeHtml(item.text)}"</div>
        <button
          class="queue-item__remove"
          onclick="removeQueueItem(${item.id})"
          title="Remove from queue"
        >
          <i class="fas fa-times"></i>
        </button>
      </div>

      <div class="queue-item__meta">
        <span class="queue-item__model">
          <i class="fas fa-microphone"></i>
          ${item.model}
        </span>
        <span class="queue-item__status queue-item__status--${item.status}">
          ${getStatusIcon(item.status)} ${getStatusText(item.status)}
        </span>
        ${item.latency ? `
          <span class="queue-item__latency">
            <i class="fas fa-clock"></i>
            ${item.latency}ms
          </span>
        ` : ''}
      </div>

      ${item.status === 'complete' ? `
        <div class="queue-item__actions">
          <button
            class="dg-btn dg-btn--primary dg-btn--sm"
            onclick="playAudio(${item.id})"
          >
            <i class="fas fa-play"></i>
            Play Again
          </button>
        </div>
      ` : ''}
    </div>
  `).join('');
}

/**
 * Remove a specific item from the queue
 *
 * @param {number} itemId - ID of item to remove
 */
function removeQueueItem(itemId) {
  console.log('🗑️ Removing queue item:', itemId);
  state.queue = state.queue.filter(item => item.id !== itemId);
  updateQueueDisplay();
}

/**
 * Clear all items from the queue
 */
function handleClearQueue() {
  console.log('🗑️ Clearing entire queue');
  state.queue = [];
  updateQueueDisplay();
}

// ============================================================================
// UI HELPERS
// ============================================================================

/**
 * Show a status message to the user
 *
 * @param {string} type - Status type: 'info', 'success', 'warning', 'error'
 * @param {string} message - Message to display
 */
function showStatus(type, message) {
  statusContainer.classList.remove('hidden', 'dg-status-banner--info', 'dg-status-banner--success', 'dg-status-banner--warning', 'dg-status-banner--danger');
  statusContainer.classList.add(`dg-status-banner--${type === 'error' ? 'danger' : type}`);

  // Update icon based on type
  const icons = {
    info: 'fa-circle-info',
    success: 'fa-circle-check',
    warning: 'fa-triangle-exclamation',
    error: 'fa-circle-xmark'
  };

  statusIcon.className = `fas ${icons[type] || icons.info}`;
  statusMessage.textContent = message;
}

/**
 * Reset the UI to ready state
 */
function resetUI() {
  generateBtn.disabled = false;
  generateBtn.innerHTML = '<i class="fas fa-play"></i> Generate Audio';
}

/**
 * Get status icon for queue items
 */
function getStatusIcon(status) {
  const icons = {
    pending: '<i class="fas fa-clock"></i>',
    generating: '<i class="fas fa-spinner spinning"></i>',
    complete: '<i class="fas fa-check"></i>',
    error: '<i class="fas fa-exclamation-triangle"></i>'
  };
  return icons[status] || '';
}

/**
 * Get human-readable status text
 */
function getStatusText(status) {
  const texts = {
    pending: 'Pending',
    generating: 'Generating...',
    complete: 'Complete',
    error: 'Error'
  };
  return texts[status] || 'Unknown';
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// GLOBAL FUNCTIONS (called from HTML onclick)
// ============================================================================

// Make these functions available globally for onclick handlers
window.playAudio = playAudio;
window.removeQueueItem = removeQueueItem;

