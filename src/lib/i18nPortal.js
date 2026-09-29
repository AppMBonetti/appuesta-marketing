// Copy for the affiliate-facing portal (/portal). Separate from the team
// dashboards' strings: an affiliate downloads only what their page shows.
export const PORTAL_STRINGS = {
  es: {
    appName: "Portal de afiliados",
    loginTitle: "Portal de afiliados", loginSub: "Ingresa el correo registrado con Appuesta y te enviaremos un enlace de acceso.",
    noAccessTitle: "Sin acceso al portal", noAccessSub: "Tu correo no está vinculado a ningún afiliado activo. Contacta a tu gestor en Appuesta.",
    teamHint: "¿Eres del equipo? Ve al dashboard de afiliados.",
    welcome: "Hola, {name}", code: "Tu código", deal: "Tu acuerdo", ofGgr: "del GGR", updated: "Datos actualizados al {d}",
    kpi: { registrations: "Registros", ftds: "Primeros depósitos", conversion: "conversión", deposits: "Depósitos", ggr: "GGR", commission: "Comisión ganada", paid: "Pagado", balance: "Saldo pendiente" },
    calc: {
      title: "Cómo se calcula tu comisión", ggr: "GGR de tus jugadores", revshare: "revenue share",
      commission: "Comisión ganada", paid: "Pagado", balance: "Saldo pendiente",
      ggrNote: "GGR = lo apostado por tus jugadores menos lo que ganaron. Cifras acumuladas desde que cada jugador se registró.",
      negative: "Tu GGR está en negativo: tus jugadores han ganado más de lo que apostaron. La comisión se recupera a medida que el GGR vuelve a positivo.",
    },
    monthly: { title: "Por mes de registro", month: "Mes" },
    payouts: { title: "Pagos recibidos", date: "Fecha", amount: "Monto", none: "Aún no hay pagos registrados." },
    players: {
      title: "Tus jugadores", ref: "Jugador", registered: "Registro", ftd: "Primer depósito", yes: "Sí",
      none: "Todavía no hay jugadores registrados con tu código.",
      privacy: "Por privacidad solo mostramos los últimos 4 dígitos de cada jugador.",
    },
  },
  en: {
    appName: "Affiliate portal",
    loginTitle: "Affiliate portal", loginSub: "Enter the email registered with Appuesta and we'll send you a sign-in link.",
    noAccessTitle: "No portal access", noAccessSub: "Your email isn't linked to an active affiliate. Contact your Appuesta manager.",
    teamHint: "On the team? Go to the affiliates dashboard.",
    welcome: "Hi, {name}", code: "Your code", deal: "Your deal", ofGgr: "of GGR", updated: "Data updated {d}",
    kpi: { registrations: "Registrations", ftds: "First deposits", conversion: "conversion", deposits: "Deposits", ggr: "GGR", commission: "Commission earned", paid: "Paid", balance: "Balance due" },
    calc: {
      title: "How your commission is calculated", ggr: "Your players' GGR", revshare: "revenue share",
      commission: "Commission earned", paid: "Paid", balance: "Balance due",
      ggrNote: "GGR = what your players staked minus what they won. Lifetime figures since each player registered.",
      negative: "Your GGR is negative: your players have won more than they staked. Commission recovers as GGR turns positive again.",
    },
    monthly: { title: "By registration month", month: "Month" },
    payouts: { title: "Payments received", date: "Date", amount: "Amount", none: "No payments recorded yet." },
    players: {
      title: "Your players", ref: "Player", registered: "Registered", ftd: "First deposit", yes: "Yes",
      none: "No players have registered with your code yet.",
      privacy: "For privacy we only show the last 4 digits of each player.",
    },
  },
};
