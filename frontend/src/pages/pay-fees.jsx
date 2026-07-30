import Head from "next/head";
import PaymentForm from "../components/PaymentForm";
import VerifyPayment from "../components/VerifyPayment";
import SseDegradedBanner from "../components/SseDegradedBanner";
import { usePaymentEvents } from "../hooks/usePaymentEvents";

const STEPS = [
  { n: "1", title: "Enter Student ID", desc: "Look up your student's details and payment status." },
  { n: "2", title: "Send via Stellar", desc: "Use any Stellar wallet — scan QR or copy address + memo." },
  { n: "3", title: "Instant confirmation", desc: "Your payment is recorded on-chain in seconds." },
];

export default function PayFees() {
  // Surface degraded/reconnecting/failed banner (Issues #1054, #1078).
  const { degraded, connectionStatus } = usePaymentEvents();

  return (
    <>
      <Head><title>Pay Fees | StellarEduPay</title></Head>
      <SseDegradedBanner degraded={degraded} connectionStatus={connectionStatus} />

      <div className="payfees-page">
        {/* Page header */}
        <div className="payfees-header">
          <span className="payfees-badge">
            <span className="payfees-badge-dot" />
            Live on Stellar
          </span>
          <h1>Pay School Fees</h1>
          <p>Enter your student ID to get Stellar blockchain payment instructions. Payments confirm in 3–5 seconds.</p>
        </div>

        {/* How it works — inline steps */}
        <div className="payfees-steps">
          {STEPS.map(step => (
            <div key={step.n} className="payfees-step">
              <div className="payfees-step-num">{step.n}</div>
              <div className="payfees-step-text">
                <h3>{step.title}</h3>
                <p>{step.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Main content grid */}
        <div className="payfees-grid">
          <PaymentForm />
          <VerifyPayment />
        </div>
      </div>
    </>
  );
}
