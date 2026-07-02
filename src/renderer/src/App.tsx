const App = () => {
  return (
    <div className="flex h-dvh items-center justify-center">
      <button
        type="button"
        onClick={() => window.api.ping()}
        className="rounded bg-white px-2 text-black"
      >
        Ping
      </button>
    </div>
  );
};

export default App;
