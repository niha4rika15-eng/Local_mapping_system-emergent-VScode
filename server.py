
"""Minimal FastAPI backend for PCNS. Frontend is pure vanilla JS using browser APIs + localStorage.
Backend exposes health check only; app is client-side.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="PCNS Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "pcns-backend"}


@app.get("/api/")
async def root():
    return {"message": "PCNS backend — frontend is vanilla JS + localStorage"}
