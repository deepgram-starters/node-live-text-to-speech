/**
 * ============================================================================
 * LIVE TEXT-TO-SPEECH - FRONTEND APPLICATION
 * ============================================================================
 *
 * ThisJavaScript application provides a real-time TTS interface
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
  currentlyPlayingId: null,  // ID of the currently playing audio item
};

let textInput;
let modelSelect;
let generateBtn;
let cancelBtn;
let statusContainer;
let statusIcon;
let statusMessage;
let queueCount;
let clearQueueBtn;
let emptyState;
let queueList;
let audioPlayer;

/**
 * Initializes the application when the DOM is ready
 */
document.addEventListener('DOMContentLoaded', () => {
  console.log('Initializing Live TTS application...');

  // Cache DOM elements
  textInput = document.getElementById('textInput');
  modelSelect = document.getElementById('modelSelect');
  generateBtn = document.getElementById('generateBtn');
  cancelBtn = document.getElementById('cancelBtn');
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
  cancelBtn.addEventListener('click', handleCancel);
  clearQueueBtn.addEventListener('click', handleClearQueue);

  // Initialize UI
  updateQueueDisplay();

  console.log('Application initialized');
});

/**
 * Handles the "Generate Audio" button click
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

  console.log('Starting generation:', { text: text.substring(0, 50) + '...', model });

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
  cancelBtn.hidden = false;
  showStatus('info', 'Connecting to Deepgram...');

  // Start WebSocket connection
  connectWebSocket(text, model);
}

/**
 * Cancel the current audio generation
 * Sends Clear message to Deepgram to stop audio generation immediately
 */
function handleCancel() {
  console.log('Cancelling generation...');

  // Send Clear message to Deepgram to stop audio generation
  if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
    try {
      const clearMessage = {
        type: 'Clear'
      };
      console.log('Sending Clear message to stop audio generation');
      state.websocket.send(JSON.stringify(clearMessage));

      // Close WebSocket after a brief delay to allow Clear to be processed
      setTimeout(() => {
        if (state.websocket) {
          state.websocket.close(1000, 'User cancelled');
          state.websocket = null;
        }
      }, 100);
    } catch (error) {
      console.error('Error sending Clear message:', error);
      // If error, just close immediately
      state.websocket.close(1000, 'User cancelled');
      state.websocket = null;
    }
  }

  // Reset state
  state.isGenerating = false;
  state.isConnecting = false;
  state.currentGeneration = {
    text: '',
    model: '',
    audioChunks: [],
    startTime: null,
    metadata: null,
  };

  // Update UI
  resetUI();
  showStatus('warning', 'Generation cancelled by user');
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
    console.log('Connecting to WebSocket:', wsUrl);

    state.isConnecting = true;
    state.websocket = new WebSocket(wsUrl);

    // Set binary type to handle audio chunks
    state.websocket.binaryType = 'arraybuffer';

    /**
     * WEBSOCKET EVENT: onopen
     * Fires when connection is successfully established
     */
    state.websocket.onopen = () => {
      console.log('WebSocket connected to server');
      state.isConnecting = false;
      showStatus('info', 'Waiting for Deepgram to be ready...');

      // NOTE: We don't send the Speak message here!
      // We wait for the server to send an "Open" event, which indicates
      // that the Deepgram connection is ready. Only then do we send text.
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
          console.error('Failed to parse message:', error);
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
        console.log('Normal closure');
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
      console.error('WebSocket error:', error);
      showStatus('error', 'Connection error occurred');
      state.isConnecting = false;
      state.isGenerating = false;
      resetUI();
    };

  } catch (error) {
    console.error('Failed to create WebSocket:', error);
    showStatus('error', 'Failed to connect: ' + error.message);
    state.isGenerating = false;
    resetUI();
  }
}

/**
 * Handle JSON messages from the server
 * These include: Open, Metadata, Flushed, Close, Error
 *
 * @param {Object} message - Parsed JSON message
 */
function handleJsonMessage(message) {
  console.log('Received message:', message.type);

  switch (message.type) {
    case 'Open':
      console.log(' Deepgram is ready! Sending text...');
      showStatus('info', 'Generating audio...');

      // end the text to Deepgram, since Deepgram is ready
      const speakMessage = {
        type: 'Speak',
        text: state.currentGeneration.text
      };
      console.log('📤 Sending text to Deepgram...');
      state.websocket.send(JSON.stringify(speakMessage));
      break;

    case 'Metadata':
      handleMetadata(message);
      break;

    case 'Flushed':
      handleFlushed();
      break;

    case 'Cleared':
      console.log('Deepgram buffer cleared, sequence_id:', message.sequence_id);
      // Buffer cleared successfully - audio generation stopped
      break;

    case 'Close':
      console.log('Server closed connection');
      if (state.websocket) {
        state.websocket.close(1000, 'Server closed');
      }
      break;

    case 'Error':
      handleError(message.error);
      break;

    default:
      console.warn(' Unknown message type:', message.type);
  }
}

/**
 * Handle Metadata message from Deepgram
 * Contains information about the TTS request and model
 *
 * @param {Object} metadata - Metadata object from Deepgram
 */
function handleMetadata(metadata) {
  console.log('Metadata received:', metadata);

  state.currentGeneration.metadata = {
    request_id: metadata.request_id,
    model_name: metadata.model_name,
    model_version: metadata.model_version,
    model_uuid: metadata.model_uuid,
  };
};

/**
 * Handle incoming audio chunk (binary data)
 * Collect chunks to play later when all chunks arrive
 *
 * @param {ArrayBuffer} arrayBuffer - Binary audio data
 */
function handleAudioChunk(arrayBuffer) {
  const chunkSize = arrayBuffer.byteLength;
  console.log(`Received audio chunk: ${chunkSize} bytes`);

  // Converts and store audio chunk
  const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
  state.currentGeneration.audioChunks.push(blob);

  // Update status with chunk count
  const chunkCount = state.currentGeneration.audioChunks.length;
  showStatus('info', `Receiving audio... (${chunkCount} chunk${chunkCount > 1 ? 's' : ''})`);
}

/**
 * Create a WAV header for raw PCM audio data
 * @param {number} dataSize - Size of the PCM audio data in bytes
 * @returns {Uint8Array} - WAV header as a byte array
 */
function createWavHeader(dataSize) {
  const sampleRate = 48000;  // Must match server.js encoding settings
  const numChannels = 1;     // Mono audio
  const bitsPerSample = 16;  // 16-bit PCM (linear16)
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const fileSize = 36 + dataSize; // 44 byte header - 8 bytes + data size

  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);

  // "RIFF" chunk descriptor
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, fileSize, true);    // File size - 8
  view.setUint32(8, 0x57415645, false); // "WAVE"

  // "fmt " sub-chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);          // Subchunk size (16 for PCM)
  view.setUint16(20, 1, true);           // Audio format (1 = PCM)
  view.setUint16(22, numChannels, true); // Number of channels
  view.setUint32(24, sampleRate, true);  // Sample rate
  view.setUint32(28, byteRate, true);    // Byte rate
  view.setUint16(32, blockAlign, true);  // Block align
  view.setUint16(34, bitsPerSample, true); // Bits per sample

  // "data" sub-chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true);    // Data size

  return header;
}

/**
 * Handle Flushed message from Deepgram
 */
function handleFlushed() {
  console.log('All audio chunks received (Flushed)');

  // Calculate metrics
  const latency = Date.now() - state.currentGeneration.startTime;
  const chunkCount = state.currentGeneration.audioChunks.length;
  const pcmDataSize = state.currentGeneration.audioChunks.reduce((sum, blob) => sum + blob.size, 0);

  // Calculate actual audio duration from PCM data
  // Formula: bytes / (sample_rate * bytes_per_sample * channels)
  // 48000 Hz, 16-bit (2 bytes), mono (1 channel)
  const audioDurationSeconds = pcmDataSize / (48000 * 2 * 1);

  console.log(`Generation latency: ${latency}ms`);
  console.log(`Chunks: ${chunkCount} • Audio duration: ${audioDurationSeconds.toFixed(2)}s • PCM size: ${pcmDataSize} bytes`);

  // Create WAV header for the PCM data
  const wavHeader = createWavHeader(pcmDataSize);

  // Combine WAV header + all PCM audio chunks into a proper WAV file
  const completeAudioBlob = new Blob([wavHeader, ...state.currentGeneration.audioChunks], { type: 'audio/wav' });
  console.log(`Complete WAV file size: ${completeAudioBlob.size} bytes (${wavHeader.length} byte header + ${pcmDataSize} byte data)`);

  // Add to queue with detailed metrics
  const queueItem = {
    id: state.nextId++,
    text: state.currentGeneration.text,
    model: state.currentGeneration.model,
    audioBlob: completeAudioBlob,
    latency: latency,
    chunkCount: chunkCount,
    audioDuration: audioDurationSeconds,
    status: 'complete',
    metadata: state.currentGeneration.metadata,
  };

  state.queue.unshift(queueItem); // Add to front of queue

  // Update UI with detailed metrics
  showStatus('success', `Generated ${chunkCount} chunks • ${audioDurationSeconds.toFixed(1)}s audio in ${(latency / 1000).toFixed(2)}s`);
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
 * Handle Error message from server to display error clearly
 *
 * @param {Object} error - Error object with type, code, message
 */
function handleError(error) {
  console.error('Error from server:', error);

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

/**
 * Play audio for a specific queue item
 *
 * @param {number} itemId - ID of the queue item to play
 */
function playAudio(itemId) {
  const item = state.queue.find(q => q.id === itemId);

  if (!item || !item.audioBlob) {
    console.error('No audio blob found for item:', itemId);
    return;
  }

  console.log('Playing audio for item:', itemId);

  // Stop any currently playing audio
  if (state.currentlyPlayingId !== null) {
    stopAudio();
  }

  // Creates an object URL from the Blob and plays the audio
  const audioUrl = URL.createObjectURL(item.audioBlob);
  audioPlayer.src = audioUrl;
  audioPlayer.play();

  // Track which audio is playing
  state.currentlyPlayingId = itemId;
  updateQueueDisplay();

  audioPlayer.onended = () => {
    URL.revokeObjectURL(audioUrl);
    state.currentlyPlayingId = null;
    updateQueueDisplay();
    console.log('Playback complete');
  };
}

/**
 * Stop the currently playing audio
 */
function stopAudio() {
  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    audioPlayer.src = '';
    state.currentlyPlayingId = null;
    updateQueueDisplay();
    console.log('Playback stopped');
  }
}

// Make functions globally accessible for onclick handlers
window.playAudio = playAudio;
window.stopAudio = stopAudio;

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
        ${item.chunkCount && item.audioDuration && item.latency ? `
          <span class="queue-item__latency">
            <i class="fas fa-layer-group"></i>
            ${item.chunkCount} chunks
          </span>
          <span class="queue-item__latency">
            <i class="fas fa-comment"></i>
            ${item.audioDuration.toFixed(1)}s audio
          </span>
          <span class="queue-item__latency">
            <i class="fas fa-clock"></i>
            ${(item.latency / 1000).toFixed(2)}s generated
          </span>
        ` : ''}
      </div>

      ${item.status === 'complete' ? `
        <div class="queue-item__actions">
          <button
            class="dg-btn dg-btn--primary dg-btn--sm"
            onclick="playAudio(${item.id})"
            ${state.currentlyPlayingId === item.id ? 'disabled' : ''}
          >
            <i class="fas fa-play"></i>
            ${state.currentlyPlayingId === item.id ? 'Playing...' : 'Play Again'}
          </button>
          ${state.currentlyPlayingId === item.id ? `
            <button
              class="dg-btn dg-btn--danger-ghost dg-btn--sm"
              onclick="stopAudio()"
            >
              <i class="fas fa-stop"></i>
              Stop Playing
            </button>
          ` : ''}
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
  console.log('Removing queue item:', itemId);
  state.queue = state.queue.filter(item => item.id !== itemId);
  updateQueueDisplay();
}

/**
 * Clear all items from the queue
 */
function handleClearQueue() {
  console.log('Clearing entire queue');
  state.queue = [];
  updateQueueDisplay();
}

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
  cancelBtn.hidden = true;
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


// Make these functions available globally for onclick handlers
window.playAudio = playAudio;
window.removeQueueItem = removeQueueItem;

