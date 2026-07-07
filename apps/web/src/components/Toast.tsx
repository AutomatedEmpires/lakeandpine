"use client";

import { useEffect, useRef, useState } from "react";

export function Toast() {
  const [message, setMessage] = useState("");
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onToast(event: Event) {
      const detail = (event as CustomEvent<string>).detail;
      setMessage(detail);
      setShow(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setShow(false), 2300);
    }
    window.addEventListener("lp:toast", onToast);
    return () => window.removeEventListener("lp:toast", onToast);
  }, []);

  return (
    <div className={`toast${show ? " show" : ""}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}
