class CycleError(Exception):
    def __init__(self, cycle):
        super().__init__(' -> '.join(cycle))
        self.cycle = cycle


def order(deps: dict) -> list:
    raise NotImplementedError
