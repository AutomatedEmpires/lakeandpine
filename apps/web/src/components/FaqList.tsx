"use client";

import { useState } from "react";

export function FaqList({ faqs }: { faqs: { question: string; answer: string }[] }) {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <div className="faq-list">
      {faqs.map((faq, i) => (
        <article key={faq.question} className={`faq card${i === openIndex ? " open" : ""}`}>
          <button onClick={() => setOpenIndex(i === openIndex ? -1 : i)} aria-expanded={i === openIndex}>
            {faq.question}
            <span aria-hidden>⌄</span>
          </button>
          <div>{faq.answer}</div>
        </article>
      ))}
    </div>
  );
}
