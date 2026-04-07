"""
Perplexity Clone — Flask Backend
Uses google-genai SDK with Gemini 2.5 Flash.
Serves the static frontend and provides a streaming /api/chat endpoint.
"""

import sys
import io

# Force UTF-8 encoding for standard output to prevent Crawl4AI/Rich logger crashing on Windows
if sys.stdout and hasattr(sys.stdout, 'encoding') and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
if sys.stderr and hasattr(sys.stderr, 'encoding') and sys.stderr.encoding.lower() != 'utf-8':
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

import os
import json
import time
import uuid
import numpy as np
from PyPDF2 import PdfReader
from flask import Flask, request, Response, send_from_directory, jsonify
from google import genai
from google.genai import types
from dotenv import load_dotenv

import asyncio
from duckduckgo_search import DDGS
try:
    from crawl4ai import AsyncWebCrawler
except ImportError:
    class AsyncWebCrawler: pass

# Load environment variables
load_dotenv()

# ---------------------------------------------------------------------------
# Configuration (with API Key Fallback)
# ---------------------------------------------------------------------------
# Construct API keys list securely
API_KEYS = []
key1 = os.getenv("GEMINI_API_KEY_1")
if key1:
    API_KEYS.append(key1)

key2 = os.getenv("GEMINI_API_KEY_2")
if key2:
    API_KEYS.append(key2)

if not API_KEYS:
    raise ValueError("❌ No Gemini API keys found. Please set GEMINI_API_KEY_1 in a .env file.")

MODEL_ID = "gemini-2.5-flash"

current_key_index = 0

def get_client():
    """Returns a GenAI client using the current active key."""
    return genai.Client(api_key=API_KEYS[current_key_index % len(API_KEYS)])

def rotate_key():
    """Switches to the next API key in the list."""
    global current_key_index
    current_key_index += 1
    print(f"🔄 Switched to API Key {current_key_index % len(API_KEYS) + 1} due to rate limits.")

def is_overloaded_error(exc):
    """Check if an exception is a transient overload / rate-limit error."""
    msg = str(exc).lower()
    return any(kw in msg for kw in ["429", "503", "overloaded", "quota", "resource", "capacity", "unavailable"])

app = Flask(__name__, static_folder=".", static_url_path="")

# Simple In-Memory Store for RAG components
RAG_STORE = {}

def chunk_text(text, chunk_size=800, overlap=150):
    """Simple character-based chunking logic."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start += chunk_size - overlap
    return chunks
# ---------------------------------------------------------------------------
# Static file serving
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# File Upload API — Reads PDF & Prepares RAG chunks
# ---------------------------------------------------------------------------
@app.route("/api/upload", methods=["GET", "POST"], strict_slashes=False)
def upload_file():
    if request.method == "GET":
        return jsonify({"message": "Please use POST to upload a file to this endpoint."}), 200
        
    if 'file' not in request.files:
        return jsonify({"error": "No file part passed in request"}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400
    
    if file and file.filename.lower().endswith('.pdf'):
        try:
            reader = PdfReader(file)
            text = ""
            for page in reader.pages:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + "\n"
            
            if not text.strip():
                return jsonify({"error": "Could not extract readable text from this PDF."}), 400
                
            chunks = chunk_text(text)
            
            # Generate embeddings for all chunks via Gemini (with fallback)
            try:
                client = get_client()
                embeddings_resp = client.models.embed_content(
                    model='gemini-embedding-001',
                    contents=chunks
                )
            except Exception as e:
                if "429" in str(e) or "quota" in str(e).lower():
                    rotate_key()
                    client = get_client()
                    embeddings_resp = client.models.embed_content(
                        model='gemini-embedding-001',
                        contents=chunks
                    )
                else:
                    raise e
            
            # Convert values to numpy arrays for fast cosine similarity later
            vectors = [np.array(e.values) for e in embeddings_resp.embeddings]
            
            doc_id = str(uuid.uuid4())
            RAG_STORE[doc_id] = {
                "chunks": chunks,
                "vectors": vectors,
                "filename": file.filename
            }
            
            return jsonify({
                "document_id": doc_id,
                "chunks": len(chunks)
            })
            
        except Exception as e:
            return jsonify({"error": f"Error parsing PDF: {str(e)}"}), 500
            
    return jsonify({"error": "Invalid file format, only PDF allowed"}), 400


# ---------------------------------------------------------------------------
# Web Search & Crawling Pipeline
# ---------------------------------------------------------------------------
def fetch_web_context(query):
    """Synchronous wrapper around the async crawler to get web context with extreme reliability."""
    async def crawl_urls(urls):
        async with AsyncWebCrawler(verbose=False) as crawler:
            results = []
            for url in urls:
                try:
                    # Timeout after 8 seconds per URL to prevent dropping sources from hanging
                    res = await asyncio.wait_for(crawler.arun(url=url), timeout=8.0)
                    if res.markdown:
                        results.append({"url": url, "content": res.markdown[:1500]}) # Truncate to save tokens
                except Exception as e:
                    print(f"Error crawling {url}: {e}")
            return results

    try:
        results = []
        # Attempt fallback backends to absolutely guarantee DuckDuckGo search returns results
        for backend in ['lite', 'api', 'html']:
            try:
                with DDGS() as ddgs:
                    results = list(ddgs.text(query, max_results=5, backend=backend))
                if results:
                    break
            except Exception as e:
                print(f"DDGS {backend} error: {e}")
                
        if not results:
            return "", []

        sources = []
        urls_to_crawl = []
        for r in results:
            url = r.get("href")
            title = r.get("title")
            snippet = r.get("body")
            sources.append({"title": title, "url": url, "snippet": snippet})
            urls_to_crawl.append(url)

        # Crawl top 3 URLs only for full content
        crawled_data = asyncio.run(crawl_urls(urls_to_crawl[:3]))

        context_str = "\n\n--- WEB SEARCH RESULTS ---\n"
        for i, src in enumerate(sources):
            crawled_content = next((c['content'] for c in crawled_data if c['url'] == src['url']), "No full content available - rely on snippet.")
            context_str += f"\n[{i+1}] Title: {src['title']}\nURL: {src['url']}\nSnippet: {src['snippet']}\nFull Content Extract:\n{crawled_content}\n\n---\n"
        
        context_str += "Use the above web search results to answer the query accurately. YOU MUST include inline citations like [1], [2] corresponding to the sources used.\n"
        context_str += "CRITICAL: At the very end of your response, you MUST provide a 'Sources' section listing all the available search results provided to you above, including their titles and URLs. Do this automatically without asking.\n"

        return context_str, sources

    except Exception as e:
        print(f"Web search error: {e}")
        return "", []


# ---------------------------------------------------------------------------
# Chat API — streaming Server-Sent Events (SSE)
# ---------------------------------------------------------------------------
@app.route("/api/chat", methods=["GET", "POST"], strict_slashes=False)
def chat():
    if request.method == "GET":
        return jsonify({"message": "The chat API is active. Please use POST with a JSON body to send messages."}), 200
    
    """
    Expects JSON body:
    {
        "messages": [
            {"role": "user", "content": "Hello"},
            {"role": "model", "content": "Hi there!"},
            {"role": "user", "content": "What is Flask?"}
        ]
    }
    Streams the response back as SSE events.
    """
    data = request.get_json(silent=True)
    if not data or "messages" not in data:
        return jsonify({"error": "Request body must contain 'messages' array."}), 400

    raw_messages = data["messages"]

    # Build the history for Gemini: all messages except the last one
    history = []
    for msg in raw_messages[:-1]:
        history.append(
            types.Content(
                role=msg["role"],
                parts=[types.Part.from_text(text=msg["content"])],
            )
        )

    # The final user message is the new prompt
    user_prompt = raw_messages[-1]["content"]

    # --- RAG Injection ---
    document_id = data.get("document_id")
    deal_room_id = data.get("deal_room_id")
    rag_context = ""
    
    if deal_room_id:
        try:
            # Call the DealRoom microservice for specialized context
            import requests
            # Use the same prompt to get relevant chunks from the room
            dr_resp = requests.post(
                f"http://localhost:5001/query", 
                json={"query": user_prompt, "deal_room_id": deal_room_id},
                timeout=10
            )
            if dr_resp.status_code == 200:
                dr_data = dr_resp.json()
                if dr_data.get("success"):
                    rag_context = f"\n\n--- CONTEXT FROM DEALROOM ({deal_room_id}) ---\n"
                    rag_context += dr_data.get("data", {}).get("answer", "")
                    rag_context += "\n---------------------------\n"
        except Exception as e:
            print(f"DealRoom API Error: {e}")

    if not rag_context and document_id and document_id in RAG_STORE:
        doc = RAG_STORE[document_id]
        try:
            # Embed user prompt to find matching text (with fallback)
            try:
                client = get_client()
                prompt_resp = client.models.embed_content(
                    model='gemini-embedding-001',
                    contents=user_prompt
                )
            except Exception as e:
                if "429" in str(e) or "quota" in str(e).lower():
                    rotate_key()
                    client = get_client()
                    prompt_resp = client.models.embed_content(
                        model='gemini-embedding-001',
                        contents=user_prompt
                    )
                else:
                    raise e
            prompt_vec = np.array(prompt_resp.embeddings[0].values)
            
            # Calculate cosine similarity
            similarities = []
            for vec in doc["vectors"]:
                sim = np.dot(prompt_vec, vec) / (np.linalg.norm(prompt_vec) * np.linalg.norm(vec))
                similarities.append(sim)
                
            # Grab top 3 chunks
            top_indices = np.argsort(similarities)[-3:][::-1]
            top_chunks = [doc["chunks"][i] for i in top_indices]
            
            rag_context = f"\n\n--- EXTRACTED CONTEXT FROM UPLOADED PDF ({doc['filename']}) ---\n"
            rag_context += "\n\n...\n\n".join(top_chunks)
            rag_context += "\n---------------------------\n"
            rag_context += "Use the above context to answer the user's query if relevant. If the context doesn't contain the answer, say so.\n"
        except Exception as e:
            print(f"RAG Error: {e}")
            pass # Fail gracefully if embedding limits are hit
    
    system_instruction = (
        "You are Perplexity, a helpful AI assistant. "
        "Provide clear, accurate, and well-structured answers. "
        "Use markdown formatting when appropriate for readability. "
        "Be concise but thorough.\n\n"
        "CRITICAL MATH FORMATTING RULES:\n"
        "- ALWAYS use LaTeX notation for mathematical equations.\n"
        "- Use $...$ for inline math.\n"
        "- Use $$...$$ for display math (block equations on their own lines).\n"
        "- Make sure complex equations (like fractions, integrals, matrices) are always put in a $$ block.\n"
    ) + rag_context

    def generate():
        """Generator that yields SSE events from Gemini streaming response."""
        # Yield searching status first
        pulse_payload = json.dumps({"status": "searching"})
        yield f"data: {pulse_payload}\n\n"

        # --- Web Search Injection ---
        web_context, sources = "", []
        try:
            web_context, sources = fetch_web_context(user_prompt)
            if sources:
                # Send sources immediately so UI renders them
                yield f"data: {json.dumps({'sources': sources})}\n\n"
        except Exception as e:
            print(f"Web Search Error: {e}")

        # Update system instruction dynamically
        dynamic_instruction = system_instruction
        if web_context:
            dynamic_instruction += web_context

        MAX_RETRIES = 3
        last_error = None

        for attempt in range(MAX_RETRIES):
            try:
                # Rotate API key on failure, always use gemini-2.5-flash
                if attempt > 0:
                    rotate_key()
                    wait_secs = min(2 ** attempt, 8)
                    print(f"⏳ Retry {attempt}/{MAX_RETRIES} with Key {current_key_index % len(API_KEYS) + 1}, waiting {wait_secs}s...")
                    time.sleep(wait_secs)

                client = get_client()
                response = client.models.generate_content_stream(
                    model=MODEL_ID,
                    contents=[
                        *history,
                        types.Content(
                            role="user",
                            parts=[types.Part.from_text(text=user_prompt)],
                        ),
                    ],
                    config=types.GenerateContentConfig(
                        system_instruction=dynamic_instruction,
                        temperature=0.7,
                        top_p=0.95,
                        max_output_tokens=8192,
                    ),
                )

                for chunk in response:
                    if chunk.text:
                        payload = json.dumps({"text": chunk.text})
                        yield f"data: {payload}\n\n"

                # Signal completion
                yield f"data: {json.dumps({'done': True})}\n\n"
                return  # Success — exit the retry loop

            except Exception as exc:
                last_error = exc
                if is_overloaded_error(exc) and attempt < MAX_RETRIES - 1:
                    print(f"⚠️ Attempt {attempt+1} failed ({exc}), will retry...")
                    continue  # Retry
                else:
                    break  # Non-retryable or last attempt

        # All retries exhausted
        error_payload = json.dumps({"error": str(last_error)})
        yield f"data: {error_payload}\n\n"

    return Response(generate(), mimetype="text/event-stream")


# ---------------------------------------------------------------------------
# Static file serving
# ---------------------------------------------------------------------------
@app.route("/")
def serve_index():
    return send_from_directory(".", "index.html")


@app.route("/<path:filename>")
def serve_static(filename):
    return send_from_directory(".", filename)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("\n  Perplexity Clone running at http://localhost:5000\n")
    app.run(host="0.0.0.0", port=5000, debug=True)
