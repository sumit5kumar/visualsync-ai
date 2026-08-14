import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch } from "wouter";
import DashboardLayout from "./components/DashboardLayout";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Gemini from "./pages/Gemini";
import Home from "./pages/Home";
import NotFound from "./pages/NotFound";
import Preview from "./pages/Preview";
import Projects from "./pages/Projects";
import Settings from "./pages/Settings";
import Timeline from "./pages/Timeline";
function Router() { return <DashboardLayout><Switch><Route path="/" component={Home} /><Route path="/projects" component={Projects} /><Route path="/gemini" component={Gemini} /><Route path="/timeline" component={Timeline} /><Route path="/preview" component={Preview} /><Route path="/settings" component={Settings} /><Route path="/404" component={NotFound} /><Route component={NotFound} /></Switch></DashboardLayout>; }
export default function App() { return <ErrorBoundary><ThemeProvider defaultTheme="dark"><TooltipProvider><Toaster richColors theme="dark" /><Router /></TooltipProvider></ThemeProvider></ErrorBoundary>; }
