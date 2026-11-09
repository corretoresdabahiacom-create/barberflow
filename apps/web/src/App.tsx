import { Navigate, Route, Routes } from "react-router-dom";
import { InstallBanner } from "./components/InstallBanner";
import { AdminApp } from "./pages/admin/Admin";
import { CustomerPortal } from "./pages/Customer";
import { Landing } from "./pages/Landing";
import { Privacy, Terms } from "./pages/Legal";
import { Login } from "./pages/Login";
import { ManageAppointment, PublicBooking } from "./pages/PublicBooking";

export function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/entrar" element={<Login />} />
        <Route path="/b/:slug" element={<PublicBooking />} />
        <Route path="/agendamento/:id" element={<ManageAppointment />} />
        <Route path="/c" element={<CustomerPortal />} />
        <Route path="/app/*" element={<AdminApp />} />
        <Route path="/termos" element={<Terms />} />
        <Route path="/privacidade" element={<Privacy />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <InstallBanner />
    </>
  );
}
